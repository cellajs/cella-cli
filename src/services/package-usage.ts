/**
 * Where the fork's own code still uses a package or a script.
 *
 * The package sync removes an entry upstream dropped when the fork never touched it in
 * package.json, but a fork can use an inherited entry without touching it: an import in a
 * fork-only module, a CLI in a fork script, a script name in a fork workflow. Only fork-authored
 * content is searched: files that differ from upstream after the file merge, and package.json
 * scripts the fork added or changed. Upstream no longer uses what it dropped, so a reference in
 * that content is the fork's own. A false match keeps the entry, which is the safe side: a stale
 * entry costs an install, a missing one breaks the fork.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../utils/git';
import { isManagedFile, isPackageJson } from '../utils/managed-files';
import { isUnderAnyFolder } from '../utils/overrides';

/** Fork-authored content: a file, or one package.json script. */
interface ForkSource {
  /** Repo-relative path, which scopes a workspace's packages to its directory */
  path: string;
  /** Where the reference is, as reported to the user */
  label: string;
  /** The content, read on first use */
  text: () => string;
}

/** Answers where the fork still uses an entry upstream dropped; undefined when nowhere. */
export interface ForkUsage {
  /** A fork-authored place inside `location` that imports `name` or runs one of its CLIs */
  findPackage(location: string, name: string): string | undefined;
  /** A fork-authored place anywhere in the repo that runs script `name` through a package manager */
  findScript(name: string): string | undefined;
}

/** Larger files are generated or binary and are not searched. */
const MAX_FILE_BYTES = 1024 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A file's text, or '' when it is missing, too large or binary. */
function readSearchable(filePath: string): string {
  try {
    if (statSync(filePath).size > MAX_FILE_BYTES) return '';
    const text = readFileSync(filePath, 'utf-8');
    return text.includes('\0') ? '' : text;
  } catch {
    return '';
  }
}

function fileSource(forkPath: string, path: string): ForkSource {
  let text: string | undefined;
  return { path, label: path, text: () => (text ??= readSearchable(join(forkPath, path))) };
}

async function readScriptsAtRef(forkPath: string, ref: string, path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await git(['show', `${ref}:${path}`], forkPath)).scripts ?? {};
  } catch {
    return {};
  }
}

/** The scripts of a fork package.json that differ from both the merge-base and upstream. */
async function scriptSources(
  forkPath: string,
  upstreamRef: string,
  baseRef: string,
  path: string,
): Promise<ForkSource[]> {
  let forkScripts: Record<string, string>;
  try {
    forkScripts = JSON.parse(readFileSync(join(forkPath, path), 'utf-8')).scripts ?? {};
  } catch {
    return [];
  }
  const baseScripts = await readScriptsAtRef(forkPath, baseRef, path);
  const upstreamScripts = await readScriptsAtRef(forkPath, upstreamRef, path);

  return Object.entries(forkScripts)
    .filter(([name, value]) => value !== baseScripts[name] && value !== upstreamScripts[name])
    .map(([name, value]) => ({ path, label: `${path} (scripts.${name})`, text: () => value }));
}

/** The CLI names a package installs, from its installed package.json; its bare name when not installed. */
function binNames(forkPath: string, location: string, name: string): string[] {
  const bareName = name.split('/').pop() as string;
  for (const dir of [join(forkPath, location), forkPath]) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const { bin } = JSON.parse(readFileSync(manifest, 'utf-8'));
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
function packagePatterns(forkPath: string, location: string, name: string): RegExp[] {
  const specifiers = [name];
  const typed = name.match(/^@types\/(.+)$/);
  if (typed) specifiers.push(typed[1].includes('__') ? `@${typed[1].replace('__', '/')}` : typed[1]);

  const patterns = specifiers.map((specifier) => new RegExp(`(['"\`])${escapeRegExp(specifier)}(?:/[^'"\`\\s]*)?\\1`));
  for (const bin of binNames(forkPath, location, name)) {
    patterns.push(new RegExp(`(?:^|[\\s'"\`(;&|=])${escapeRegExp(bin)}(?=$|[\\s'"\`);&|])`, 'm'));
  }
  return patterns;
}

/** A package manager command that names the script as a whole word, e.g. `pnpm --filter backend geoip:download`. */
function scriptPattern(name: string): RegExp {
  return new RegExp(`\\b(?:pnpm|npm|yarn|bun)\\s+(?:[^\\n;&|]*?\\s)?${escapeRegExp(name)}(?=$|[\\s'"\`);&|])`, 'm');
}

/**
 * Collect the fork-authored content: files in the working tree (the merge result) that differ
 * from upstream, minus managed files, plus the scripts the fork added or changed. Call before
 * any package.json is rewritten.
 */
export async function loadForkUsage(forkPath: string, upstreamRef: string, baseRef: string): Promise<ForkUsage> {
  const diff = await git(['diff', '--name-only', '-z', '--diff-filter=d', upstreamRef], forkPath);
  const sources: ForkSource[] = [];

  for (const path of diff.split('\0').filter(Boolean)) {
    if (isPackageJson(path)) sources.push(...(await scriptSources(forkPath, upstreamRef, baseRef, path)));
    else if (!isManagedFile(path)) sources.push(fileSource(forkPath, path));
  }

  const findIn = (scoped: ForkSource[], patterns: RegExp[]) =>
    scoped.find((source) => patterns.some((pattern) => pattern.test(source.text())))?.label;

  return {
    findPackage: (location, name) =>
      findIn(
        location ? sources.filter((source) => isUnderAnyFolder(source.path, [location])) : sources,
        packagePatterns(forkPath, location, name),
      ),
    findScript: (name) => findIn(sources, [scriptPattern(name)]),
  };
}
