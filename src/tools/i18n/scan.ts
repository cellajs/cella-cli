import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as TS from 'typescript';
import { importFromWorkspace } from '../../utils/app-facts';

/** A place in a repository's code. */
export interface Site {
  file: string;
  line: number;
  /** What `t()` or `i18nKey` reads as the key. */
  keyArgument?: boolean;
  /** The key of a `t()` call whose options carry a `context`, so i18next also reads `<key>_<context>`. */
  context?: boolean;
}

/**
 * A key the code builds at runtime: a template that starts with a namespace, `` `c:${role}` ``, or one passed to `t()`
 * or `i18nKey` without it, `` t(`${type}.text`) ``.
 */
export interface DynamicSite extends Site {
  /** Undefined when the template names none: its keys may be in any namespace. */
  namespace?: string;
  /** The template as written, without its backticks. */
  source: string;
  /** The key with `*` for each part the types leave open: `c:success.*_resource`. */
  pattern: string;
  /** Every key it builds, when the types close each part. */
  keys?: string[];
}

export interface CodeScan {
  repo: string;
  files: number;
  ms: number;
  /** `ns:key` literals, by key. */
  literals: Map<string, Site[]>;
  /** Literals without a namespace that equal a key of some namespace: an error type, a `t()` default namespace. */
  bare: Map<string, Site[]>;
  dynamic: DynamicSite[];
}

const codeFile = /\.(?:[cm]?[jt]sx?)$/;
/** Generated output, locale files and alignments, whose old keys are history: never a use. */
const skipped = (path: string) =>
  path.endsWith('.d.ts') ||
  path.startsWith('locales/') ||
  path.startsWith('shared/locales/') ||
  path.startsWith('cella/alignments/') ||
  path.split('/').some((segment) => segment === 'node_modules' || segment === 'gen' || segment.includes('.gen.'));
/** A larger file is a bundle or a fixture. */
const MAX_FILE_BYTES = 1_000_000;
/** A template whose parts combine into more keys than this is reported by its pattern. */
const MAX_COMBINATIONS = 500;

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The code files of a repository: tracked ones and new ones git does not ignore. */
export function listCodeFiles(repoPath: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split('\0'))].filter((path) => codeFile.test(path) && !skipped(path));
}

/**
 * The app's own TypeScript, which parses the code and types the parts of a built key.
 * @throws when the repository root has no `typescript` with the compiler API
 */
export async function loadTypeScript(forkPath: string): Promise<typeof TS> {
  const ts = await importFromWorkspace<typeof TS>(forkPath, '.', 'typescript');
  if (typeof ts.createSourceFile !== 'function') {
    throw new Error('cella i18n reads the code with the TypeScript compiler API: the root `typescript` has none');
  }
  return ts;
}

const scriptKind = (ts: typeof TS, path: string) =>
  path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : path.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

/** Whether a node is what `t()` or `i18nKey` reads as the key: the first argument, or a fallback in its key array. */
function isKeyArgument(ts: typeof TS, node: TS.Node): boolean {
  const parent = ts.isArrayLiteralExpression(node.parent) ? node.parent : node;
  const call = parent.parent;
  if (call && ts.isCallExpression(call) && call.arguments[0] === parent) {
    const callee = call.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    return name === 't';
  }
  return (
    ts.isJsxExpression(node.parent) &&
    ts.isJsxAttribute(node.parent.parent) &&
    node.parent.parent.name.getText() === 'i18nKey'
  );
}

/** Whether a node is the key of a `t()` call whose options object has a `context` property. */
function readsContext(ts: typeof TS, node: TS.Node): boolean {
  if (!isKeyArgument(ts, node)) return false;
  const call = (ts.isArrayLiteralExpression(node.parent) ? node.parent : node).parent;
  const options = ts.isCallExpression(call) ? call.arguments[1] : undefined;
  return (
    !!options &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      ({ name }) => !!name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'context',
    )
  );
}

const add = (map: Map<string, Site[]>, key: string, site: Site) => {
  const sites = map.get(key);
  if (sites) sites.push(site);
  else map.set(key, [site]);
};

/** The string values a type closes to, or undefined when any member is open (`string`, a template type). */
function literalValues(ts: typeof TS, checker: TS.TypeChecker, type: TS.Type): string[] | undefined {
  const values: string[] = [];
  for (const member of type.isUnion() ? type.types : [type]) {
    if (member.isStringLiteral()) values.push(member.value);
    else if (member.isNumberLiteral()) values.push(String(member.value));
    else if (member.flags & ts.TypeFlags.BooleanLiteral) values.push(checker.typeToString(member));
    else if (!(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never))) return undefined;
  }
  return values;
}

/** Every key a template builds from the values of its parts. */
function combine(head: string, parts: { values: string[]; tail: string }[]): string[] | undefined {
  let keys = [head];
  for (const { values, tail } of parts) {
    keys = keys.flatMap((key) => values.map((value) => `${key}${value}${tail}`));
    if (keys.length > MAX_COMBINATIONS) return undefined;
  }
  return keys;
}

interface PendingSite {
  site: DynamicSite;
  start: number;
}

/**
 * Types the parts of each built key with the program of the file's nearest `tsconfig.json`, rooted at the files that
 * build keys only: a checker types lazily, so this reads far less than a typecheck.
 */
function resolveTemplates(ts: typeof TS, repoPath: string, pending: Map<string, PendingSite[]>): void {
  const byConfig = new Map<string, string[]>();
  for (const file of pending.keys()) {
    const config = ts.findConfigFile(dirname(join(repoPath, file)), ts.sys.fileExists) ?? '';
    byConfig.set(config, [...(byConfig.get(config) ?? []), file]);
  }
  for (const [config, files] of byConfig) {
    const parsed = config
      ? ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
      : undefined;
    const program = ts.createProgram({
      rootNames: files.map((file) => join(repoPath, file)),
      options: { ...parsed?.options, noEmit: true, incremental: false, skipLibCheck: true },
    });
    const checker = program.getTypeChecker();
    const keysOf = (node: TS.TemplateExpression): string[] | undefined => {
      const parts: { values: string[]; tail: string }[] = [];
      for (const span of node.templateSpans) {
        const values = literalValues(ts, checker, checker.getTypeAtLocation(span.expression));
        if (!values) return undefined;
        parts.push({ values, tail: span.literal.text });
      }
      return combine(node.head.text, parts);
    };
    for (const file of files) {
      const sourceFile = program.getSourceFile(join(repoPath, file));
      if (!sourceFile) continue;
      const starts = new Map((pending.get(file) ?? []).map((entry) => [entry.start, entry.site]));
      const visit = (node: TS.Node): void => {
        const site = ts.isTemplateExpression(node) ? starts.get(node.getStart(sourceFile)) : undefined;
        if (site && ts.isTemplateExpression(node)) site.keys = keysOf(node);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
}

/**
 * Every translation key a repository's code names: `ns:key` literals, literals equal to a key, and templates that
 * build one, with the keys their parts' types allow.
 * @param namespaces - the runtime namespaces a literal may name before its `:`
 * @param keys - every key of every namespace, to recognize a literal without its namespace
 */
export function scanCode(
  ts: typeof TS,
  repoPath: string,
  repo: string,
  namespaces: string[],
  keys: Set<string>,
): CodeScan {
  const started = performance.now();
  const prefix = new RegExp(`^(${namespaces.map(escapeRegExp).join('|')}):`);
  const scan: CodeScan = { repo, files: 0, ms: 0, literals: new Map(), bare: new Map(), dynamic: [] };
  const pending = new Map<string, PendingSite[]>();

  for (const file of listCodeFiles(repoPath)) {
    const path = join(repoPath, file);
    let text: string;
    try {
      if (statSync(path).size > MAX_FILE_BYTES) continue;
      text = readFileSync(path, 'utf8');
    } catch {
      // Listed by git but gone from the working tree
      continue;
    }
    scan.files++;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
    const lineOf = (node: TS.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

    const visit = (node: TS.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const site = () => ({ file, line: lineOf(node), context: readsContext(ts, node) || undefined });
        if (prefix.test(node.text)) add(scan.literals, node.text, site());
        else if (keys.has(node.text)) add(scan.bare, node.text, { ...site(), keyArgument: isKeyArgument(ts, node) });
      } else if (ts.isTemplateExpression(node)) {
        const match = prefix.exec(node.head.text);
        if (match || isKeyArgument(ts, node)) {
          const source = node.getText(sourceFile).slice(1, -1);
          const pattern = `${node.head.text}${node.templateSpans.map((span) => `*${span.literal.text}`).join('')}`;
          const context = readsContext(ts, node) || undefined;
          const site: DynamicSite = { file, line: lineOf(node), namespace: match?.[1], source, pattern, context };
          scan.dynamic.push(site);
          pending.set(file, [...(pending.get(file) ?? []), { site, start: node.getStart(sourceFile) }]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (pending.size > 0) resolveTemplates(ts, repoPath, pending);
  scan.ms = Math.round(performance.now() - started);
  return scan;
}

/** Whether a pattern leaves the whole key open, `c:*`, so it says nothing about which keys are used. */
export const isOpenPattern = (pattern: string): boolean => /^(?:[^:*]+:)?\*+$/.test(pattern);

/** A pattern as a test for `ns:key`. */
export function patternTest(pattern: string): (key: string) => boolean {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return (key) => regex.test(key);
}
