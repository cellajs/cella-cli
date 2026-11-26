import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Severity levels, most severe first. */
export const severities = ['critical', 'high', 'moderate', 'low', 'info'] as const;

export type VulnerabilitySeverity = (typeof severities)[number];

/** The most severe of `found`; null when it is empty. */
export const worstSeverity = (found: VulnerabilitySeverity[]): VulnerabilitySeverity | null =>
  severities.find((severity) => found.includes(severity)) ?? null;

/** One package in `pnpm -r outdated --json --long`. */
export interface OutdatedPackage {
  /** Missing for a dependency that is not installed. */
  current?: string;
  latest: string;
  dependencyType: 'dependencies' | 'devDependencies';
  dependentPackages: Array<{ name: string; location: string }>;
  latestManifest?: { repository?: { url?: string } };
}

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
 * pnpm prints warnings, such as a Node version outside `engines`, on stdout ahead of the JSON, so
 * only errors are logged. Returns null for empty or unparsable output; never throws.
 */
export async function runPnpmJson(args: string[], cwd: string): Promise<unknown> {
  try {
    return JSON.parse((await runPnpm([...args, '--loglevel=error'], cwd)).stdout);
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

/** pnpm's `minimumReleaseAge` in minutes; 0 when it is unset or unreadable. */
export async function readReleaseAgeMinutes(cwd: string): Promise<number> {
  const minutes = Number.parseInt((await runPnpm(['config', 'get', 'minimumReleaseAge'], cwd)).stdout, 10);
  return Number.isNaN(minutes) ? 0 : minutes;
}

/**
 * Publish time per version of a package, as its registry lists them, next to `created` and
 * `modified` keys; null when it does not answer, or when `name` starts with `-` and would pass as an option.
 */
export async function fetchPublishTimes(name: string, cwd: string): Promise<Record<string, string> | null> {
  if (name.startsWith('-')) return null;
  const times = await runPnpmJson(['view', name, 'time', '--json'], cwd);
  // A failed lookup still prints JSON, as `{ "error": … }`.
  return times && typeof times === 'object' && !('error' in times) ? (times as Record<string, string>) : null;
}
