/**
 * Upstream override changes: the sync never merges the fork's config, so this reads upstream's
 * `overrides` lists and `packageJsonSync` keys at the merge-base and the incoming ref (ts-morph,
 * syntax only) and reports the entries the fork config does not follow. Report only.
 */

import { Node, type ObjectLiteralExpression, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import type { CellaCliConfig, OverrideListChanges, UpstreamOverridesReport } from '../config/types';
import { DEFAULT_PACKAGE_JSON_SYNC } from './config';
import { git } from './git';
import { CONFIG_FILE } from './managed-files';
import { isUnderAnyFolder, normalizeEntry } from './overrides';

/** The lists the comparison reads from a sync config, as plain string entries. */
interface OverrideLists {
  pinned: string[];
  ignored: string[];
  /** `settings.packageJsonSync`, the default when the config names none; null when it cannot be read statically. */
  packageJsonSync: string[] | null;
}

const LIST_KEYS = ['pinned', 'ignored'] as const;

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

/**
 * `settings.packageJsonSync` of a config object: the default keys when `settings` or the list is
 * absent, null when either is present without a statically readable value.
 */
function readPackageJsonSync(config: ObjectLiteralExpression, sourceFile: SourceFile): string[] | null {
  const settings = readProperty(config, 'settings', sourceFile);
  if (settings === undefined) return [...DEFAULT_PACKAGE_JSON_SYNC];
  if (!settings || !Node.isObjectLiteralExpression(settings)) return null;
  const keys = readProperty(settings, 'packageJsonSync', sourceFile);
  if (keys === undefined) return [...DEFAULT_PACKAGE_JSON_SYNC];
  return keys ? readStringEntries(keys) : null;
}

/**
 * Extract `overrides.pinned`, `overrides.ignored` and `settings.packageJsonSync` from config source
 * without evaluating it; only string literals count. Null when the config object or a present
 * `overrides`/list cannot be read statically; an unreadable `packageJsonSync` alone reads as null.
 */
export function parseOverrideLists(source: string): OverrideLists | null {
  try {
    const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
    const sourceFile = project.createSourceFile('cella.config.ts', source);
    const config = findConfigObject(sourceFile);
    if (!config) return null;

    const lists: OverrideLists = {
      pinned: [],
      ignored: [],
      packageJsonSync: readPackageJsonSync(config, sourceFile),
    };
    const overrides = readProperty(config, 'overrides', sourceFile);
    if (overrides === undefined) return lists;
    if (!overrides || !Node.isObjectLiteralExpression(overrides)) return null;

    for (const key of LIST_KEYS) {
      const list = readProperty(overrides, key, sourceFile);
      if (list === undefined) continue;
      const entries = list ? readStringEntries(list) : null;
      if (!entries) return null;
      lists[key] = entries;
    }
    return lists;
  } catch {
    return null;
  }
}

/**
 * Compare upstream's lists at the merge-base and at the incoming ref against the fork's lists.
 *
 * - added: new upstream entries the fork list lacks (an exact entry or a parent folder covers it).
 * - removed: entries upstream dropped that the fork list still carries verbatim.
 *
 * `packageJsonSync` keys compare by name, and not at all when a side could not be read. Entries
 * upstream had all along are never reported, whether or not the fork has them.
 */
export function diffOverrideLists(
  base: OverrideLists,
  incoming: OverrideLists,
  fork: OverrideLists,
): Record<(typeof LIST_KEYS)[number] | 'packageJsonSync', OverrideListChanges> {
  const diff = (key: (typeof LIST_KEYS)[number]): OverrideListChanges => {
    const baseSet = new Set(base[key].map(normalizeEntry).filter(Boolean));
    const incomingSet = new Set(incoming[key].map(normalizeEntry).filter(Boolean));
    const forkEntries = fork[key].map(normalizeEntry).filter(Boolean);
    return {
      added: [...incomingSet].filter((entry) => !baseSet.has(entry) && !isUnderAnyFolder(entry, forkEntries)),
      removed: [...baseSet].filter((entry) => !incomingSet.has(entry) && forkEntries.includes(entry)),
    };
  };
  const diffKeys = (): OverrideListChanges => {
    const [baseKeys, incomingKeys, forkKeys] = [base.packageJsonSync, incoming.packageJsonSync, fork.packageJsonSync];
    if (!baseKeys || !incomingKeys || !forkKeys) return { added: [], removed: [] };
    return {
      added: [...new Set(incomingKeys)].filter((key) => !baseKeys.includes(key) && !forkKeys.includes(key)),
      removed: [...new Set(baseKeys)].filter((key) => !incomingKeys.includes(key) && forkKeys.includes(key)),
    };
  };
  return { pinned: diff('pinned'), ignored: diff('ignored'), packageJsonSync: diffKeys() };
}

/**
 * Report how upstream's `overrides` and `packageJsonSync` changed between the merge-base and the
 * incoming ref, limited to entries the fork config does not follow (see {@link diffOverrideLists}).
 * Undefined when there is nothing to report; `unreadable` when the config is missing or unparsable
 * at one side only.
 */
export async function compareUpstreamOverrides(
  repoPath: string,
  mergeBaseRef: string,
  incomingRef: string,
  forkConfig: CellaCliConfig,
): Promise<UpstreamOverridesReport | undefined> {
  // Empty when upstream has no config at that ref.
  const [baseSource, incomingSource] = await Promise.all(
    [mergeBaseRef, incomingRef].map((ref) => git(['show', `${ref}:${CONFIG_FILE}`], repoPath, { ignoreErrors: true })),
  );
  if (baseSource === incomingSource) return undefined;

  const base = baseSource ? parseOverrideLists(baseSource) : null;
  if (!base) return { kind: 'unreadable', side: 'base' };
  const incoming = incomingSource ? parseOverrideLists(incomingSource) : null;
  if (!incoming) return { kind: 'unreadable', side: 'incoming' };

  const fork: OverrideLists = {
    pinned: forkConfig.overrides?.pinned ?? [],
    ignored: forkConfig.overrides?.ignored ?? [],
    packageJsonSync: forkConfig.settings.packageJsonSync ?? DEFAULT_PACKAGE_JSON_SYNC,
  };
  const changes = diffOverrideLists(base, incoming, fork);
  const count = Object.values(changes).reduce((n, list) => n + list.added.length + list.removed.length, 0);
  return count > 0 ? { kind: 'changes', ...changes } : undefined;
}
