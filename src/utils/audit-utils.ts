/**
 * Audit utilities: running pnpm, repository links and table formatting for the audit service.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pc from './colors';
import { parseComparableVersion } from './versions';

const execFileAsync = promisify(execFile);

/** One package in `pnpm -r outdated --json --long`. */
export interface OutdatedPackage {
  current: string;
  latest: string;
  dependencyType: 'dependencies' | 'devDependencies';
  dependentPackages: Array<{ name: string; location: string }>;
  latestManifest?: { repository?: { url?: string } };
}

export interface EnhancedPackageInfo {
  name: string;
  current: string;
  latest: string;
  dependentPackages: OutdatedPackage['dependentPackages'];
  isDev: boolean;
  isMajorUpdate: boolean;
  /** Workspace names where this package is pinned to an exact version (no ^ or ~) */
  pinnedIn: string[];
  repoUrl: string | null;
  releasesUrl: string | null;
  /** The highest severity the audit reports for the package, or null when it reports none. */
  severity: VulnerabilitySeverity | null;
}

/** Vulnerability severity levels */
export type VulnerabilitySeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

/** Audit result from pnpm audit --json */
export interface AuditResult {
  advisories: Record<string, AuditAdvisory>;
}

interface AuditAdvisory {
  id: number;
  module_name: string;
  severity: VulnerabilitySeverity;
  vulnerable_versions: string;
  url: string;
  github_advisory_id?: string;
  findings: Array<{ version: string; paths: string[] }>;
}

/** A repository URL from package metadata, normalized to a plain https:// form. */
export function getRepoUrl(repositoryUrl: string | undefined): string | null {
  if (!repositoryUrl) return null;

  let url = repositoryUrl;

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

/** The GitHub releases URL, or null for a non-GitHub repo. */
export function getReleasesUrl(repoUrl: string | null): string | null {
  if (!isGitHubRepoUrl(repoUrl)) return null;
  return `${repoUrl}/releases`;
}

/** Whether the update is a major version change. */
export function isMajorVersionChange(current: string, latest: string): boolean {
  const from = parseComparableVersion(current);
  const to = parseComparableVersion(latest);
  return !!from && !!to && to.major > from.major;
}

/** Runs a pnpm command to completion with its output captured; `ok` is false on a non-zero exit. */
export async function runPnpm(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('pnpm', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      cwd,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    // When pnpm wrote nothing (it did not start), the error itself explains the failure.
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout, stderr: stdout || stderr ? stderr : String(error) };
  }
}

/**
 * Runs a pnpm command and parses its JSON stdout. pnpm exits non-zero when it finds outdated
 * packages or vulnerabilities (expected output, not an error), so the exit code is not checked.
 * Returns null for empty or unparsable output; never throws.
 */
export async function runPnpmJson(args: string[], cwd: string): Promise<unknown> {
  try {
    return JSON.parse((await runPnpm(args, cwd)).stdout);
  } catch {
    return null;
  }
}

/**
 * Parsed `pnpm audit --json`; null when the audit could not run. A clean audit is a result with
 * no advisories, so a caller can tell "nothing found" from "no answer".
 */
export async function runPnpmAudit(cwd: string): Promise<AuditResult | null> {
  const result = (await runPnpmJson(['audit', '--json'], cwd)) as Partial<AuditResult> | null;
  if (!result || typeof result.advisories !== 'object' || result.advisories === null) return null;
  return result as AuditResult;
}

/** Publish time per version of a package, as its registry lists them; null when it does not answer. */
export async function fetchPublishTimes(name: string, cwd: string): Promise<Record<string, string> | null> {
  const times = await runPnpmJson(['view', name, 'time', '--json'], cwd);
  return times && typeof times === 'object' ? (times as Record<string, string>) : null;
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
