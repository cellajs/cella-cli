/**
 * Audit utilities: npm registry fetching, changelog detection, vulnerability
 * parsing, and caching for the audit service.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pc from './colors';

const execFileAsync = promisify(execFile);

interface OutdatedPackage {
  current: string;
  latest: string;
  dependencyType: 'dependencies' | 'devDependencies';
  dependentPackages: Array<{ name: string; location: string }>;
}

export interface NpmRegistryData {
  repository?: { url: string };
}

interface CachedPackageData {
  repoUrl: string | null;
  changelogUrl: string | null;
  fetchedAt: number;
}

interface ChangelogCache {
  [packageName: string]: CachedPackageData;
}

export interface EnhancedPackageInfo {
  name: string;
  current: string;
  latest: string;
  dependents: string[];
  dependentLocations: string[];
  isDev: boolean;
  isMajorUpdate: boolean;
  /** Workspace names where this package is pinned to an exact version (no ^ or ~) */
  pinnedIn: string[];
  repoUrl: string | null;
  changelogUrl: string | null;
  releasesUrl: string | null;
  vulnerabilities: VulnerabilityInfo[];
}

/** Vulnerability severity levels */
type VulnerabilitySeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

/** Vulnerability info for a package */
export interface VulnerabilityInfo {
  title: string;
  severity: VulnerabilitySeverity;
  vulnerableVersions: string;
  cves: string[];
  /** The workspace/dependent containing this vulnerability (e.g., 'frontend', 'backend') */
  workspace: string | null;
  /** The direct dependency in the workspace that brought in this vulnerable package */
  directDependency: string | null;
}

/** Audit result from pnpm audit --json */
export interface AuditResult {
  advisories: Record<string, AuditAdvisory>;
  metadata: {
    vulnerabilities: Record<VulnerabilitySeverity, number>;
  };
}

interface AuditAdvisory {
  id: number;
  title: string;
  module_name: string;
  severity: VulnerabilitySeverity;
  vulnerable_versions: string;
  patched_versions: string;
  cves: string[];
  url: string;
  findings: Array<{ version: string; paths: string[] }>;
}

/** Parsed dependency path info from pnpm audit */
interface DependencyPathInfo {
  /** The workspace name (e.g., 'frontend', 'backend') */
  workspace: string | null;
  /** The direct dependency in the workspace that starts the chain */
  directDependency: string | null;
}

/** Cache file location (in cli/cella directory) */
export const CACHE_FILE = join(import.meta.dirname, '..', '..', '.audit.cache.json');

/** Cache TTL: 7 days in ms */
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

/** Common changelog file paths to check in GitHub repos */
export const CHANGELOG_PATHS = ['CHANGELOG.md', 'CHANGELOG', 'changelog.md', 'HISTORY.md', 'CHANGES.md', 'NEWS.md'];

/** Default branches to check for changelog files */
export const DEFAULT_BRANCHES = ['main', 'master'] as const;

/** The changelog cache from disk; read errors yield an empty cache. */
export function loadCache(): ChangelogCache {
  try {
    if (existsSync(CACHE_FILE)) {
      return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {
    // Ignore cache read errors
  }
  return {};
}

/** Best-effort write of the changelog cache to disk. */
export function saveCache(cache: ChangelogCache): void {
  try {
    writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // Ignore cache write errors
  }
}

/** Removal of the changelog cache file, reported on the console. */
export function clearCache(): void {
  try {
    if (existsSync(CACHE_FILE)) {
      unlinkSync(CACHE_FILE);
      console.info(pc.green('✓ cache cleared successfully'));
    } else {
      console.info(pc.yellow('no cache file found'));
    }
  } catch (err) {
    console.error(pc.red('failed to clear cache:'), err);
  }
}

/** Package metadata from the npm registry, or null on any failure. */
export async function fetchNpmMetadata(packageName: string): Promise<NpmRegistryData | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}`);
    if (!response.ok) return null;
    return (await response.json()) as NpmRegistryData;
  } catch {
    return null;
  }
}

/** The repo URL from npm registry data, normalized to a plain https:// form. */
export function getRepoUrl(data: NpmRegistryData | null): string | null {
  if (!data?.repository?.url) return null;

  let url = data.repository.url;

  if (url.startsWith('git+')) {
    url = url.slice(4);
  }

  if (url.endsWith('.git')) {
    url = url.slice(0, -4);
  }

  if (url.startsWith('git://')) {
    url = url.replace('git://', 'https://');
  }

  return url;
}

/** Whether the URL points to a GitHub repository. */
function isGitHubRepoUrl(repoUrl: string | null): repoUrl is string {
  if (!repoUrl) return false;
  try {
    const parsed = new URL(repoUrl);
    return parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com';
  } catch {
    return false;
  }
}

/** The branch holding `filePath` in a GitHub repo, or null when no default branch has it. */
async function findGitHubFile(repoUrl: string, filePath: string): Promise<string | null> {
  if (!isGitHubRepoUrl(repoUrl)) return null;

  for (const branch of DEFAULT_BRANCHES) {
    const rawUrl = repoUrl.replace('github.com', 'raw.githubusercontent.com').concat(`/${branch}/${filePath}`);

    try {
      const response = await fetch(rawUrl, { method: 'HEAD' });
      if (response.ok) return branch;
    } catch {
      // Continue to next branch
    }
  }
  return null;
}

/**
 * The changelog URL for a package, found by probing common locations.
 * Results are cached to avoid repeated GitHub requests.
 */
export async function findChangelogUrl(
  repoUrl: string | null,
  packageName: string,
  cache: ChangelogCache,
): Promise<string | null> {
  if (!isGitHubRepoUrl(repoUrl)) return null;

  const cached = cache[packageName];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.changelogUrl;
  }

  for (const changelogPath of CHANGELOG_PATHS) {
    const branch = await findGitHubFile(repoUrl, changelogPath);
    if (branch) {
      const blobUrl = `${repoUrl}/blob/${branch}/${changelogPath}`;
      cache[packageName] = {
        repoUrl,
        changelogUrl: blobUrl,
        fetchedAt: Date.now(),
      };
      return blobUrl;
    }
  }

  // Cache the negative result too.
  cache[packageName] = {
    repoUrl,
    changelogUrl: null,
    fetchedAt: Date.now(),
  };

  return null;
}

/** The GitHub releases URL, or null for a non-GitHub repo. */
export function getReleasesUrl(repoUrl: string | null): string | null {
  if (!isGitHubRepoUrl(repoUrl)) return null;
  return `${repoUrl}/releases`;
}

/** Whether the update is a major version change. */
export function isMajorVersionChange(current: string, latest: string): boolean {
  const currentMajor = current.split('.')[0]?.replace(/^\D+/, '');
  const latestMajor = latest.split('.')[0]?.replace(/^\D+/, '');
  if (!currentMajor || !latestMajor) return false;
  return Number.parseInt(latestMajor, 10) > Number.parseInt(currentMajor, 10);
}

/**
 * Runs a pnpm command and parses its JSON stdout. pnpm exits non-zero when it finds outdated
 * packages or vulnerabilities (expected output, not an error), so the JSON is also rescued
 * from the error's stdout. Returns null for empty or unparsable output; never throws.
 */
async function runPnpmJson(args: string[], cwd: string): Promise<unknown> {
  const parse = (stdout?: string): unknown => {
    if (!stdout || stdout.trim() === '') return null;
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  };

  try {
    const { stdout } = await execFileAsync('pnpm', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      cwd,
    });
    return parse(stdout);
  } catch (error) {
    return parse(error instanceof Error && 'stdout' in error ? (error as { stdout: string }).stdout : undefined);
  }
}

/** Parsed `pnpm -r outdated --json`; an empty record when nothing is outdated or the check fails. */
export async function getOutdatedPackages(cwd: string): Promise<Record<string, OutdatedPackage>> {
  return ((await runPnpmJson(['-r', 'outdated', '--json'], cwd)) ?? {}) as Record<string, OutdatedPackage>;
}

/** Parsed `pnpm audit --json`; null when the audit fails or finds nothing. */
export async function runPnpmAudit(cwd: string): Promise<AuditResult | null> {
  return (await runPnpmJson(['audit', '--json'], cwd)) as AuditResult | null;
}

/**
 * Workspace and direct dependency extracted from vulnerability paths shaped like
 * "workspace>direct-dep>transitive>vulnerable-pkg". Examples:
 *   - "frontend>virtua>solid-js>seroval" -> { workspace: 'frontend', directDependency: 'virtua' }
 *   - "backend>jsx-email>esbuild" -> { workspace: 'backend', directDependency: 'jsx-email' }
 *   - "esbuild" (direct) -> { workspace: null, directDependency: null }
 */
function parseDependencyPath(paths: string[]): DependencyPathInfo {
  for (const pathStr of paths) {
    const parts = pathStr.split('>');
    if (parts.length >= 2) {
      return {
        workspace: parts[0],
        directDependency: parts.length > 2 ? parts[1] : null,
      };
    }
  }
  return { workspace: null, directDependency: null };
}

/** Map of package name -> vulnerabilities from an audit result. */
export function buildVulnerabilityMap(auditResult: AuditResult | null): Map<string, VulnerabilityInfo[]> {
  const map = new Map<string, VulnerabilityInfo[]>();
  if (!auditResult?.advisories) return map;

  for (const advisory of Object.values(auditResult.advisories)) {
    const allPaths = advisory.findings?.flatMap((f) => f.paths) || [];
    const { workspace, directDependency } = parseDependencyPath(allPaths);

    const existing = map.get(advisory.module_name) || [];
    existing.push({
      title: advisory.title,
      severity: advisory.severity,
      vulnerableVersions: advisory.vulnerable_versions,
      cves: advisory.cves || [],
      workspace,
      directDependency,
    });
    map.set(advisory.module_name, existing);
  }

  return map;
}

/** Severity dot per vulnerability level. */
const vulnIcons: Record<VulnerabilitySeverity, string> = {
  critical: pc.red('●'),
  high: pc.red('●'),
  moderate: pc.yellow('●'),
  low: pc.blue('●'),
  info: pc.gray('●'),
};

export function getVulnIcon(severity: VulnerabilitySeverity): string {
  return vulnIcons[severity] ?? pc.gray('●');
}

/** The highest severity present in a list of vulnerabilities, or null. */
export function getHighestSeverity(vulns: VulnerabilityInfo[]): VulnerabilitySeverity | null {
  if (vulns.length === 0) return null;
  const order: VulnerabilitySeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];
  for (const severity of order) {
    if (vulns.some((v) => v.severity === severity)) return severity;
  }
  return null;
}

/** Middle-truncation to maxLen, e.g. "very-long-package-name" -> "very-lo…e-name". */
export function middleTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const ellipsis = '…';
  const charsToShow = maxLen - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return str.slice(0, frontChars) + ellipsis + str.slice(-backChars);
}

/** Dependents as "first +N" when multiple. */
export function formatDependents(dependents: string[]): string {
  if (dependents.length === 0) return '';
  if (dependents.length === 1) return dependents[0];
  return `${dependents[0]} +${dependents.length - 1}`;
}
