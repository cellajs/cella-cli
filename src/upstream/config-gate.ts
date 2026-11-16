import { Node, type ObjectLiteralExpression, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import { defaultPackageJsonKeys } from '../config/load';
import type { CellaCliConfig } from '../config/types';
import { git } from '../utils/git';
import { configFile } from './managed-files';
import type { OverrideListChanges, UpstreamOverridesReport } from './model';
import { isUnderAnyFolder, normalizeEntry } from './protection';

/** The lists the comparison reads from a CLI config, as plain string entries. */
interface OverrideLists {
  pinned: string[];
  ignored: string[];
  /** The default when the config names none; null when unreadable, or false: the config merges no package.json. */
  packageJsonKeys: string[] | null;
}

const listKeys = ['pinned', 'ignored'] as const;

/**
 * Where each list sits, newest shape first: at the top level, in the 0.7 shape's `overrides` and `settings`, and as
 * `packageJsonSync` before 0.6. The merge-base can predate the app's CLI, so every shape stays readable.
 */
const listPaths: Record<keyof OverrideLists, string[][]> = {
  pinned: [['pinned'], ['overrides', 'pinned']],
  ignored: [['ignored'], ['overrides', 'ignored']],
  packageJsonKeys: [['packageJsonKeys'], ['settings', 'packageJsonKeys'], ['settings', 'packageJsonSync']],
};

/** Resolve wrappers (`(x)`, `x as T`, `x satisfies T`) and same-file identifiers to the underlying expression. */
function resolveExpression(node: Node | undefined, sourceFile: SourceFile, depth = 0): Node | undefined {
  if (!node || depth > 8) return node;
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
    return resolveExpression(node.getExpression(), sourceFile, depth + 1);
  }
  if (Node.isIdentifier(node)) {
    return resolveExpression(
      sourceFile.getVariableDeclaration(node.getText())?.getInitializer(),
      sourceFile,
      depth + 1,
    );
  }
  return node;
}

/** The config object: the `defineConfig({...})` argument, else a plain `export default {...}`. */
function findConfigObject(sourceFile: SourceFile): ObjectLiteralExpression | undefined {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'defineConfig') continue;
    const arg = resolveExpression(call.getArguments()[0], sourceFile);
    if (Node.isObjectLiteralExpression(arg)) return arg;
  }
  const exported = sourceFile.getExportAssignment((assignment) => !assignment.isExportEquals());
  const value = resolveExpression(exported?.getExpression(), sourceFile);
  return Node.isObjectLiteralExpression(value) ? value : undefined;
}

/**
 * Resolved value of a named property in an object literal: `undefined` when absent (spreads and
 * methods are not followed), `null` when present without a readable value.
 */
function readProperty(object: ObjectLiteralExpression, name: string, sourceFile: SourceFile): Node | null | undefined {
  for (const property of object.getProperties()) {
    if (Node.isPropertyAssignment(property)) {
      if (property.getName().replace(/^['"`]|['"`]$/g, '') !== name) continue;
      return resolveExpression(property.getInitializer(), sourceFile) ?? null;
    }
    if (Node.isShorthandPropertyAssignment(property) && property.getName() === name) {
      return resolveExpression(property.getNameNode(), sourceFile) ?? null;
    }
  }
  return undefined;
}

/** String entries of an array literal; null when `node` is not one. Other elements (spreads, variables) are skipped. */
function readStringEntries(node: Node): string[] | null {
  if (!Node.isArrayLiteralExpression(node)) return null;
  const entries: string[] = [];
  for (const element of node.getElements()) {
    if (Node.isStringLiteral(element) || Node.isNoSubstitutionTemplateLiteral(element)) {
      entries.push(element.getLiteralValue());
    }
  }
  return entries;
}

/** String entries at the first of `paths` the config holds: undefined when none, null when that one is unreadable. */
function readList(
  config: ObjectLiteralExpression,
  paths: string[][],
  sourceFile: SourceFile,
): string[] | null | undefined {
  for (const path of paths) {
    let node: Node | null | undefined = config;
    for (const name of path) {
      if (node === undefined) break;
      node = node && Node.isObjectLiteralExpression(node) ? readProperty(node, name, sourceFile) : null;
    }
    if (node !== undefined) return node && readStringEntries(node);
  }
  return undefined;
}

/**
 * Extract `pinned`, `ignored` and `packageJsonKeys` from config source without evaluating it, in any shape a config had
 * (see {@link listPaths}); only string literals count. Null when the config object or a present `pinned` or `ignored`
 * cannot be read statically; unreadable `packageJsonKeys` alone read as null.
 */
export function parseOverrideLists(source: string): OverrideLists | null {
  try {
    const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
    const sourceFile = project.createSourceFile('cella.config.ts', source);
    const config = findConfigObject(sourceFile);
    if (!config) return null;

    const [pinned, ignored, keys] = (['pinned', 'ignored', 'packageJsonKeys'] as const).map((key) =>
      readList(config, listPaths[key], sourceFile),
    );
    if (pinned === null || ignored === null) return null;
    return {
      pinned: pinned ?? [],
      ignored: ignored ?? [],
      packageJsonKeys: keys === undefined ? [...defaultPackageJsonKeys] : keys,
    };
  } catch {
    return null;
  }
}

/**
 * Compare upstream's lists at the merge-base and at the incoming ref against the app's lists.
 *
 * - added: new upstream entries the app lacks (an exact entry or a parent folder covers it; an ignored folder covers a pin).
 * - removed: entries upstream dropped that the app list still carries verbatim.
 * - renamed: entries the app carries that upstream dropped for a same-named new entry.
 *
 * `packageJsonKeys` compare by name, and not at all when a side could not be read. Entries
 * upstream had all along are never reported, whether or not the app has them.
 */
export function diffOverrideLists(
  base: OverrideLists,
  incoming: OverrideLists,
  app: OverrideLists,
): Record<(typeof listKeys)[number] | 'packageJsonKeys', OverrideListChanges> {
  const basenameOf = (entry: string) => entry.slice(entry.lastIndexOf('/') + 1);
  const diff = (key: (typeof listKeys)[number]): OverrideListChanges => {
    const baseSet = new Set(base[key].map(normalizeEntry).filter(Boolean));
    const incomingSet = new Set(incoming[key].map(normalizeEntry).filter(Boolean));
    const appEntries = app[key].map(normalizeEntry).filter(Boolean);
    const covering =
      key === 'pinned' ? [...appEntries, ...app.ignored.map(normalizeEntry).filter(Boolean)] : appEntries;
    const coveredBy = (entry: string) => covering.find((folder) => isUnderAnyFolder(entry, [folder]));
    const newEntries = [...incomingSet].filter((entry) => !baseSet.has(entry));
    const dropped = [...baseSet].filter((entry) => !incomingSet.has(entry));
    const takeSameNamed = (source: string, candidates: string[]) => {
      const at = candidates.findIndex((entry) => basenameOf(entry) === basenameOf(source));
      return at === -1 ? undefined : candidates.splice(at, 1)[0];
    };

    const renamed: NonNullable<OverrideListChanges['renamed']> = [];
    const removed = dropped.filter((entry) => {
      if (!appEntries.includes(entry)) return false;
      const to = takeSameNamed(entry, newEntries);
      if (to === undefined) return true;
      const cover = coveredBy(to);
      renamed.push(cover === undefined ? { from: entry, to } : { from: entry, to, coveredBy: cover });
      return false;
    });

    // A new entry that renames a base entry the app never carried asks nothing of the app.
    const uncovered = newEntries.filter((entry) => coveredBy(entry) === undefined);
    const moved: { from: string; to: string }[] = [];
    for (const from of dropped.filter((entry) => !appEntries.includes(entry) && !isUnderAnyFolder(entry, appEntries))) {
      const to = takeSameNamed(from, uncovered);
      if (to !== undefined) moved.push({ from, to });
    }

    return {
      added: uncovered,
      removed,
      ...(moved.length > 0 ? { moved } : {}),
      ...(renamed.length > 0 ? { renamed } : {}),
    };
  };
  const diffKeys = (): OverrideListChanges => {
    const [baseKeys, incomingKeys, appKeys] = [base.packageJsonKeys, incoming.packageJsonKeys, app.packageJsonKeys];
    if (!baseKeys || !incomingKeys || !appKeys) return { added: [], removed: [] };
    return {
      added: [...new Set(incomingKeys)].filter((key) => !baseKeys.includes(key) && !appKeys.includes(key)),
      removed: [...new Set(baseKeys)].filter((key) => !incomingKeys.includes(key) && appKeys.includes(key)),
    };
  };
  return { pinned: diff('pinned'), ignored: diff('ignored'), packageJsonKeys: diffKeys() };
}

/**
 * Report how upstream's `pinned`, `ignored` and `packageJsonKeys` changed between the merge-base and the
 * incoming ref (the upgrade never merges the app's config, so these reach the app by hand only), limited to entries the app config does not follow (see {@link diffOverrideLists}).
 * Undefined when there is nothing to report; `unreadable` when the config is missing or unparsable
 * at one side only.
 */
export async function compareUpstreamOverrides(
  repoPath: string,
  mergeBaseRef: string,
  incomingRef: string,
  appConfig: CellaCliConfig,
): Promise<UpstreamOverridesReport | undefined> {
  // Empty when upstream has no config at that ref.
  const [baseSource, incomingSource] = await Promise.all(
    [mergeBaseRef, incomingRef].map((ref) => git(['show', `${ref}:${configFile}`], repoPath, { ignoreErrors: true })),
  );
  if (baseSource === incomingSource) return undefined;

  const base = baseSource ? parseOverrideLists(baseSource) : null;
  if (!base) return { type: 'unreadable', side: 'base' };
  const incoming = incomingSource ? parseOverrideLists(incomingSource) : null;
  if (!incoming) return { type: 'unreadable', side: 'incoming' };

  const app: OverrideLists = {
    pinned: appConfig.pinned ?? [],
    ignored: appConfig.ignored ?? [],
    packageJsonKeys: appConfig.packageJsonKeys === false ? null : (appConfig.packageJsonKeys ?? defaultPackageJsonKeys),
  };
  const changes = diffOverrideLists(base, incoming, app);
  const count = Object.values(changes).reduce(
    (n, list) => n + list.added.length + list.removed.length + (list.moved?.length ?? 0) + (list.renamed?.length ?? 0),
    0,
  );
  return count > 0 ? { type: 'changes', ...changes } : undefined;
}

/**
 * Whether the report holds entries the app must follow by hand. `moved` entries never block a merge, nor a rename
 * whose new path an app entry already protects; any other rename does, since the old entry would protect nothing after it.
 */
export function hasBlockingOverrideChanges(report: UpstreamOverridesReport): boolean {
  if (report.type !== 'changes') return false;
  const lists = [report.pinned, report.ignored, report.packageJsonKeys];
  return lists.some(
    (list) =>
      list.added.length > 0 ||
      list.removed.length > 0 ||
      (list.renamed ?? []).some((entry) => entry.coveredBy === undefined),
  );
}
