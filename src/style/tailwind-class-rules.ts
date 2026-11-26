import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { importFromWorkspace } from '../utils/app';
import { isGeneratedFile } from '../utils/repo-files';
import { classTexts, classTokens, splitToken } from './class-strings';
import { type Finding, lineColumn, parseSource, type Rule } from './rule';

/** Third-party class prefixes: the library's own stylesheet or DOM code reads them. */
const libraryPrefixes: Record<string, string> = {
  'bn-': 'BlockNote editor parts',
  rdg: 'data grid rows, cells and states',
};

const groupPattern = /^(?:group|peer)(?:\/[\w-]+)?$/;
const tailwindImport = /@import\s+['"]tailwindcss(?:\/[\w.-]+)?['"]/;

interface DesignSystem {
  candidatesToCss(classes: string[]): (string | null)[];
}

interface TailwindNode {
  __unstable__loadDesignSystem(css: string, options: { base: string }): Promise<DesignSystem>;
}

/** The loaded design system plus the class names that stylesheets, scripts and arbitrary selectors use. */
export interface TailwindContext {
  /** Repo-relative stylesheet that imports Tailwind. */
  entry: string;
  /** Absent when loading failed, as on an `@apply` of an unknown class; `loadError` then holds Tailwind's message. */
  designSystem?: DesignSystem;
  loadError?: string;
  /** Class names a stylesheet, script or arbitrary selector uses, and the marker classes. */
  knownClasses: Set<string>;
  /** Every candidate sent to Tailwind so far, and whether it compiled to CSS. */
  compiles: Map<string, boolean>;
}

function isFrontendScript(file: string): boolean {
  return /^frontend\/src\/.*\.tsx?$/.test(file) && !file.endsWith('.d.ts') && !isGeneratedFile(file);
}

function isFrontendStylesheet(file: string): boolean {
  return /^frontend\/src\/.*\.css$/.test(file);
}

/** Test files pass made-up class names to check prop forwarding and merging. */
export function isClassSource(file: string): boolean {
  return isFrontendScript(file) && !/\.test\.tsx?$/.test(file);
}

/** `@tailwindcss/node` from the frontend package, directly or through `@tailwindcss/vite`, which depends on it. */
export async function loadTailwindNode(root: string): Promise<TailwindNode> {
  try {
    return await importFromWorkspace<TailwindNode>(root, 'frontend', '@tailwindcss/node');
  } catch {
    const plugin = createRequire(join(root, 'frontend/package.json')).resolve('@tailwindcss/vite');
    return importFromWorkspace<TailwindNode>(root, relative(root, dirname(plugin)), '@tailwindcss/node');
  }
}

function addMatches(target: Set<string>, text: string, pattern: RegExp): void {
  for (const match of text.matchAll(pattern)) target.add(match[1]);
}

/** Class names a stylesheet selects, a script queries or toggles, or an arbitrary selector such as `group-[.x]` names. */
function usedClassNames(root: string, files: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files.filter(isFrontendStylesheet)) {
    const css = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    addMatches(names, css, /(?<!\\)\.(-?[_a-zA-Z][\w-]*)/g);
  }
  for (const file of files.filter(isFrontendScript)) {
    const source = readFileSync(join(root, file), 'utf8');
    // Arbitrary selectors (`group-[.x]`, `[&_.x]`); a bracket after a name, `)`, `]` or `?.` indexes code.
    for (const [chunk] of source.matchAll(/(?<![\w$)\]?.])\[[^\s'"`]*/g)) addMatches(names, chunk, /(?<![a-zA-Z0-9$.)\]?!])\.(-?[_a-zA-Z][\w-]*)/g);
    // Selector strings for querySelector, closest and the like.
    for (const [, , text] of source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      if (/^[\w\s.#>+~,:()[\]="*-]+$/.test(text)) addMatches(names, text, /(?:^|[\s>+~,(])\.(-?[_a-zA-Z][\w-]*)/g);
    }
    for (const [, args] of source.matchAll(/(?:classList\.(?:add|contains|remove|replace|toggle)|getElementsByClassName)\(([^)]*)\)/g)) {
      for (const [, text] of args.matchAll(/['"`]([^'"`]+)['"`]/g)) for (const name of text.split(/\s+/)) names.add(name);
    }
  }
  return names;
}

/** The design system from the frontend stylesheet that imports Tailwind; undefined in a repo without one. */
export async function tailwindContext(root: string, files: string[], markerClasses: string[]): Promise<TailwindContext | undefined> {
  const entry = files.filter(isFrontendStylesheet).find((file) => tailwindImport.test(readFileSync(join(root, file), 'utf8')));
  if (!entry) return undefined;
  const path = join(root, entry);
  const knownClasses = usedClassNames(root, files);
  for (const name of markerClasses) knownClasses.add(name);
  const context: TailwindContext = { entry, knownClasses, compiles: new Map() };
  try {
    context.designSystem = await (await loadTailwindNode(root)).__unstable__loadDesignSystem(readFileSync(path, 'utf8'), {
      base: dirname(path),
    });
  } catch (error) {
    context.loadError = error instanceof Error ? error.message : String(error);
  }
  return context;
}

/** Compiles the candidates `context.compiles` does not hold yet, in one call, and records each result there. */
function compileCandidates(context: TailwindContext, designSystem: DesignSystem, candidates: string[]): void {
  const unknown = [...new Set(candidates)].filter((candidate) => !context.compiles.has(candidate));
  const css = designSystem.candidatesToCss(unknown);
  for (const [index, candidate] of unknown.entries()) context.compiles.set(candidate, css[index] !== null);
}

/** Why `token` produces nothing, or undefined when Tailwind compiles it or it is a known non-Tailwind class. */
function problem(context: TailwindContext, token: string): string | undefined {
  if (context.compiles.get(token) || groupPattern.test(token) || context.knownClasses.has(token)) return undefined;
  if (Object.keys(libraryPrefixes).some((prefix) => token.startsWith(prefix))) return undefined;
  const { base } = splitToken(token);
  if (base !== token && (context.knownClasses.has(base) || groupPattern.test(base))) {
    return `${base} is a plain CSS class, so variants and ! do not apply to it; define it with @utility`;
  }
  return 'Tailwind compiles no CSS for it and no stylesheet or script selects it; fix the name, or list it under markerClasses in shared/config/style-exceptions.ts';
}

/**
 * Class names in one frontend file that compile to no CSS. Tailwind itself rejects an `@apply` of an unknown class
 * while loading, which this reports on the entry stylesheet.
 */
export const tailwindClassRule: Rule = {
  id: 'tailwind-class',
  reads: (file) => isClassSource(file) || isFrontendStylesheet(file),
  check: (file, source, { tailwind }) => {
    if (!tailwind) return [];
    const { designSystem, loadError } = tailwind;
    if (!designSystem)
      return file === tailwind.entry ? [{ file, rule: 'tailwind-class', message: `Tailwind cannot load this stylesheet: ${loadError}` }] : [];
    if (!isClassSource(file)) return [];
    const found = classTexts(parseSource(file, source)).flatMap(classTokens);
    compileCandidates(
      tailwind,
      designSystem,
      found.map(({ token }) => token),
    );
    return found.flatMap(({ token, offset }): Finding[] => {
      const message = problem(tailwind, token);
      return message ? [{ file, ...lineColumn(source, offset), rule: 'tailwind-class', term: token, message }] : [];
    });
  },
};
