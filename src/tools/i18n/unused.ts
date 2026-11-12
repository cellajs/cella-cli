import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveForkBasePath, validateForkPath } from '../../services/fork-utils';
import pc from '../../utils/colors';
import { loadConfig } from '../../utils/config';
import { checkMark, createSpinner, plural, spinnerSuccess, warningMark, writeStdout } from '../../utils/display';
import { errorMessage } from '../../utils/errors';
import { CONFIG_FILE } from '../../utils/managed-files';
import {
  type Locales,
  lineOf,
  namespaceTexts,
  pluralForm,
  readLocales,
  SOURCE_LANGUAGE,
  withPluralForms,
} from './locales';
import {
  type CodeScan,
  type DynamicSite,
  isOpenPattern,
  loadTypeScript,
  patternTest,
  type Site,
  scanCode,
} from './scan';

/** A repository to scan: this app, or a fork named in `cella/cella.config.ts`. */
interface Repo {
  name: string;
  path: string;
}

interface KeyUse {
  /** Repositories that name the key: a literal, or a template whose types build it. */
  repos: string[];
  /** A literal without a namespace equals it: an error type, or a word such as `'color'`. */
  bare: boolean;
  /** A template's pattern may build it. */
  pattern: boolean;
}

export interface UnusedReport {
  repos: { name: string; files: number; ms: number }[];
  /** Forks named in the config whose local path is missing, so their uses are unknown. */
  missingForks: string[];
  unused: { key: string; file: string; line: number }[];
  /** No code here names them; a fork does. */
  usedOnlyInForks: { key: string; repos: string[] }[];
  /**
   * No code names them for certain: a template's pattern may build them (`c:success.*_resource`), or a literal
   * without its namespace equals them, such as `'color'`.
   */
  unverified: { key: string; by: 'pattern' | 'literal' }[];
  /** Templates whose types leave the whole key open, so they may build any key of their namespace. */
  openSites: (DynamicSite & { repo: string })[];
}

/**
 * This app, and the forks of `cella/cella.config.ts` that exist on this machine, their paths relative to the main
 * checkout. The config loads only for this job.
 */
async function reposToScan(forkPath: string): Promise<{ repos: Repo[]; missingForks: string[] }> {
  const basePath = await resolveForkBasePath(forkPath);
  const repos: Repo[] = [{ name: basename(basePath), path: forkPath }];
  const missingForks: string[] = [];
  if (!existsSync(join(forkPath, CONFIG_FILE))) return { repos, missingForks };
  for (const fork of (await loadConfig(forkPath)).forks ?? []) {
    const validated = validateForkPath(fork, basePath);
    if (validated.valid) repos.push({ name: fork.name, path: validated.resolvedPath });
    else missingForks.push(`${fork.name} (${validated.error})`);
  }
  return { repos, missingForks };
}

/** Every English key as `ns:key`, with the file and line that define it. */
function definedKeys(locales: Locales): Map<string, Site> {
  const keys = new Map<string, Site>();
  for (const [namespace, files] of locales.namespaces) {
    for (const key of Object.keys(namespaceTexts(locales, SOURCE_LANGUAGE, namespace))) {
      const file = [...files]
        .reverse()
        .map((name) => locales.files.get(`${SOURCE_LANGUAGE}/${name}`))
        .find((entry) => entry?.entries.some((e) => e.key === key));
      if (file) keys.set(`${namespace}:${key}`, { file: file.path, line: lineOf(file, key) });
    }
  }
  return keys;
}

/** How each defined key is used across the scanned repositories. */
function classify(defined: Map<string, Site>, scans: CodeScan[]): Map<string, KeyUse> {
  const uses = new Map<string, KeyUse>();
  const use = (key: string) => {
    let entry = uses.get(key);
    if (!entry) {
      entry = { repos: [], bare: false, pattern: false };
      uses.set(key, entry);
    }
    return entry;
  };
  // A key read with a `context` also reads `<key>_<context>` and its plural forms: every defined `<key>_` key
  const formsOf = (key: string, context = false) =>
    context
      ? [...defined.keys()].filter((form) => form === key || form.startsWith(`${key}_`))
      : withPluralForms(key).filter((form) => defined.has(form));
  const markExact = (key: string, repo: string, context?: boolean) => {
    for (const form of formsOf(key, context)) {
      const entry = use(form);
      if (!entry.repos.includes(repo)) entry.repos.push(repo);
    }
  };
  const withContext = (sites: Site[]) => sites.some((site) => site.context);
  // A key without its namespace, from a bare literal or a template that names none, may be in any namespace
  const bareKeys = new Map<string, string[]>();
  for (const key of defined.keys()) {
    const bare = key.slice(key.indexOf(':') + 1);
    bareKeys.set(bare, [...(bareKeys.get(bare) ?? []), key]);
  }

  for (const scan of scans) {
    for (const [key, sites] of scan.literals) markExact(key, scan.repo, withContext(sites));
    for (const [value, sites] of scan.bare) {
      for (const key of bareKeys.get(value) ?? []) {
        for (const form of formsOf(key, withContext(sites))) use(form).bare = true;
      }
    }
    for (const site of scan.dynamic) {
      if (site.keys) {
        for (const key of site.keys) {
          for (const full of site.namespace ? [key] : (bareKeys.get(key) ?? [])) {
            markExact(full, scan.repo, site.context);
          }
        }
      } else if (!isOpenPattern(site.pattern)) {
        const test = patternTest(site.pattern);
        for (const key of defined.keys()) {
          if (site.namespace ? test(key) : test(key.slice(key.indexOf(':') + 1))) use(key).pattern = true;
        }
      }
    }
  }
  return uses;
}

export async function buildUnused(forkPath: string): Promise<UnusedReport> {
  const locales = readLocales(forkPath);
  const defined = definedKeys(locales);
  const ts = await loadTypeScript(forkPath);
  const { repos, missingForks } = await reposToScan(forkPath);
  const namespaces = [...locales.namespaces.keys()];
  const bareKeys = new Set([...defined.keys()].map((key) => key.slice(key.indexOf(':') + 1)));
  // Plural forms are found through their base, so a literal of the base alone counts
  for (const key of [...bareKeys]) {
    const form = pluralForm(key);
    if (form) bareKeys.add(form.base);
  }

  const scans: CodeScan[] = [];
  for (const repo of repos) {
    const spinner = createSpinner(`scanning ${repo.name}`);
    try {
      scans.push(scanCode(ts, repo.path, repo.name, namespaces, bareKeys));
    } finally {
      spinner.stop();
    }
  }

  const uses = classify(defined, scans);
  const [here] = repos;
  const report: UnusedReport = {
    repos: scans.map(({ repo, files, ms }) => ({ name: repo, files, ms })),
    missingForks,
    unused: [],
    usedOnlyInForks: [],
    unverified: [],
    openSites: scans.flatMap((scan) =>
      scan.dynamic
        .filter((site) => !site.keys && isOpenPattern(site.pattern))
        .map((site) => ({ ...site, repo: scan.repo })),
    ),
  };
  for (const [key, site] of defined) {
    const entry = uses.get(key);
    if (entry?.repos.includes(here.name)) continue;
    if (entry && entry.repos.length > 0) report.usedOnlyInForks.push({ key, repos: entry.repos });
    else if (entry?.pattern) report.unverified.push({ key, by: 'pattern' });
    else if (entry?.bare) report.unverified.push({ key, by: 'literal' });
    else report.unused.push({ key, ...site });
  }
  return report;
}

const LIST_MAX = 12;

function printUnused(report: UnusedReport): void {
  const [here, ...forks] = report.repos;
  const forkLine =
    forks.length > 0
      ? ` · ${forks.map((fork) => fork.name).join(', ')} +${forks.reduce((sum, fork) => sum + fork.files, 0)} files`
      : '';
  spinnerSuccess(
    `${here.name} ${here.files} files${forkLine} in ${(report.repos.reduce((sum, repo) => sum + repo.ms, 0) / 1000).toFixed(1)} s`,
  );
  for (const fork of report.missingForks) console.info(`${warningMark} fork ${fork}: its uses are unknown`);
  console.info();

  const width = Math.min(48, Math.max(0, ...report.unused.slice(0, LIST_MAX).map(({ key }) => key.length)) + 2);
  console.info(`${pc.bold(forks.length > 0 ? 'unused everywhere' : 'unused')} ${pc.dim(String(report.unused.length))}`);
  for (const { key, file, line } of report.unused.slice(0, LIST_MAX))
    console.info(`  ${key.padEnd(width)}${pc.dim(`${file}:${line}`)}`);
  if (report.unused.length > LIST_MAX)
    console.info(`  ${pc.dim(`… ${report.unused.length - LIST_MAX} more, --json for the list`)}`);

  if (forks.length > 0) {
    console.info();
    console.info(`${pc.bold('used only in a fork')} ${pc.dim(`${report.usedOnlyInForks.length} · keep them`)}`);
    for (const { key, repos } of report.usedOnlyInForks.slice(0, LIST_MAX))
      console.info(`  ${key.padEnd(width)}${pc.dim(repos.join(' · '))}`);
    if (report.usedOnlyInForks.length > LIST_MAX)
      console.info(`  ${pc.dim(`… ${report.usedOnlyInForks.length - LIST_MAX} more`)}`);
  }

  const byLiteral = report.unverified.filter(({ by }) => by === 'literal').map(({ key }) => key);
  const byPattern = report.unverified.length - byLiteral.length;
  console.info();
  console.info(
    `${pc.bold('unverified')} ${pc.dim(`${report.unverified.length} · ${byPattern} a template's pattern may build, ${byLiteral.length} only a literal without the namespace names`)}`,
  );
  if (byLiteral.length > 0) {
    const more = byLiteral.length > LIST_MAX ? `, … ${byLiteral.length - LIST_MAX} more` : '';
    console.info(`  ${pc.dim(`by a literal: ${byLiteral.slice(0, LIST_MAX).join(', ')}${more}`)}`);
  }
  if (report.openSites.length > 0)
    console.info(`  ${pc.dim(`${plural(report.openSites.length, 'template')} that may build any key:`)}`);
  for (const site of report.openSites.slice(0, LIST_MAX)) {
    console.info(`  ${pc.dim(`${forks.length > 0 ? `${site.repo} ` : ''}${site.file}:${site.line}`)}  ${site.source}`);
  }
  if (report.openSites.length > LIST_MAX)
    console.info(`  ${pc.dim(`… ${report.openSites.length - LIST_MAX} more, --json for the list`)}`);
  if (report.unused.length === 0) {
    console.info();
    console.info(`${checkMark} every key is used`);
  }
}

/** `cella i18n unused`: keys no code names, in this app and in the forks the config names. */
export async function runUnused(forkPath: string, json: boolean): Promise<number> {
  let report: UnusedReport;
  try {
    report = await buildUnused(forkPath);
  } catch (error) {
    throw new Error(`i18n unused: ${errorMessage(error)}`);
  }
  if (json) writeStdout(JSON.stringify(report, null, 2));
  else printUnused(report);
  return 0;
}
