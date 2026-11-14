/**
 * Where the app's own code still uses a package or a script.
 *
 * The package merge removes an entry upstream dropped when the app never touched it in
 * package.json, but an app can use an inherited entry without touching it: an import in an
 * app-only module, a CLI in an app script, a script name in an app workflow. Only app-authored
 * content is searched: files that differ from upstream after the file merge, and package.json
 * scripts the app added or changed. Upstream no longer uses what it dropped, so a reference in
 * that content is the app's own. A false match keeps the entry, which is the safe side: a stale
 * entry costs an install, a missing one breaks the app.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../utils/git';
import { isManagedFile, isPackageJson } from './managed-files';
import { isUnderAnyFolder } from './protection';

/** App-authored content: a file, or one package.json script. */
interface AppSource {
  /** Repo-relative path, which scopes a workspace's packages to its directory */
  path: string;
  /** Where the reference is, as reported to the user */
  label: string;
  /** The content, read on first use */
  text: () => string;
}

/** Answers where the app still uses an entry upstream dropped; undefined when nowhere. */
export interface AppUsage {
  /** An app-authored place inside `location` that imports `name` or runs one of its CLIs */
  findPackage(location: string, name: string): string | undefined;
  /** An app-authored place anywhere in the repo that runs script `name` through a package manager */
  findScript(name: string): string | undefined;
}

/** Larger files are generated or binary and are not searched. */
const maxFileBytes = 1024 * 1024;

/** A file's text, or '' when it is missing, too large or binary. */
function readSearchable(filePath: string): string {
  try {
    if (statSync(filePath).size > maxFileBytes) return '';
    const text = readFileSync(filePath, 'utf8');
    return text.includes('\0') ? '' : text;
  } catch {
    return '';
  }
}

const codeFilePattern = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const proseFilePattern = /\.(?:md|mdx|markdown)$/i;

/**
 * Code with its block comments and full-line `//` comments dropped: a mention there is prose, not
 * use. A trailing `//` after code stays, which at worst keeps an entry.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function fileSource(repoRoot: string, path: string): AppSource {
  let text: string | undefined;
  const read = () => {
    const content = readSearchable(join(repoRoot, path));
    return codeFilePattern.test(path) ? stripComments(content) : content;
  };
  return { path, label: path, text: () => (text ??= read()) };
}

async function readScriptsAtRef(repoRoot: string, ref: string, path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await git(['show', `${ref}:${path}`], repoRoot)).scripts ?? {};
  } catch {
    return {};
  }
}

/** The scripts of an app package.json that differ from both the merge-base and upstream. */
async function scriptSources(
  repoRoot: string,
  upstreamRef: string,
  baseRef: string,
  path: string,
): Promise<AppSource[]> {
  let appScripts: Record<string, string>;
  try {
    appScripts = JSON.parse(readFileSync(join(repoRoot, path), 'utf8')).scripts ?? {};
  } catch {
    return [];
  }
  const baseScripts = await readScriptsAtRef(repoRoot, baseRef, path);
  const upstreamScripts = await readScriptsAtRef(repoRoot, upstreamRef, path);

  return Object.entries(appScripts)
    .filter(([name, value]) => value !== baseScripts[name] && value !== upstreamScripts[name])
    .map(([name, value]) => ({ path, label: `${path} (scripts.${name})`, text: () => value }));
}

/** The CLI names a package installs, from its installed package.json; its bare name when not installed. */
function binNames(repoRoot: string, location: string, name: string): string[] {
  const bareName = name.split('/').pop() as string;
  for (const dir of [join(repoRoot, location), repoRoot]) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof bin === 'string') return [bareName];
      return bin && typeof bin === 'object' ? Object.keys(bin) : [];
    } catch {
      return [];
    }
  }
  return [bareName];
}

/**
 * How code refers to a package: a quoted specifier or subpath (imports, requires, config
 * strings), the package an `@types/*` entry types, and its CLI names as whole words.
 */
function packagePatterns(repoRoot: string, location: string, name: string): RegExp[] {
  const specifiers = [name];
  const typed = name.match(/^@types\/(.+)$/);
  if (typed) specifiers.push(typed[1].includes('__') ? `@${typed[1].replace('__', '/')}` : typed[1]);

  const patterns = specifiers.map((specifier) => new RegExp(`(['"\`])${RegExp.escape(specifier)}(?:/[^'"\`\\s]*)?\\1`));
  for (const bin of binNames(repoRoot, location, name)) {
    patterns.push(new RegExp(`(?:^|[\\s'"\`(;&|=])${RegExp.escape(bin)}(?=$|[\\s'"\`);&|])`, 'm'));
  }
  return patterns;
}

/** A package manager command that names the script as a whole word, e.g. `pnpm --filter backend geoip:download`. */
function scriptPattern(name: string): RegExp {
  return new RegExp(`\\b(?:pnpm|npm|yarn|bun)\\s+(?:[^\\n;&|]*?\\s)?${RegExp.escape(name)}(?=$|[\\s'"\`);&|])`, 'm');
}

/**
 * Collect the app-authored content: files in the working tree (the merge result) that differ
 * from upstream, minus managed files, plus the scripts the app added or changed. Call before
 * any package.json is rewritten.
 */
export async function loadAppUsage(repoRoot: string, upstreamRef: string, baseRef: string): Promise<AppUsage> {
  const diff = await git(['diff', '--name-only', '-z', '--diff-filter=d', upstreamRef], repoRoot);
  const sources: AppSource[] = [];

  for (const path of diff.split('\0').filter(Boolean)) {
    if (isPackageJson(path)) sources.push(...(await scriptSources(repoRoot, upstreamRef, baseRef, path)));
    // Markdown only mentions a package or script; a mention is not use.
    else if (!isManagedFile(path) && !proseFilePattern.test(path)) sources.push(fileSource(repoRoot, path));
  }

  const findIn = (scoped: AppSource[], patterns: RegExp[]) =>
    scoped.find((source) => patterns.some((pattern) => pattern.test(source.text())))?.label;

  return {
    findPackage: (location, name) =>
      findIn(
        location ? sources.filter((source) => isUnderAnyFolder(source.path, [location])) : sources,
        packagePatterns(repoRoot, location, name),
      ),
    findScript: (name) => findIn(sources, [scriptPattern(name)]),
  };
}
