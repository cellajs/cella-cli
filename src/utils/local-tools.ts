/**
 * The tools this machine works on the workspace with: the Node that runs it, the pnpm a terminal
 * starts, and gh. Each is checked for the security fixes it misses. The audit only reports them,
 * with the upgrade command that fits how the tool was installed.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { fetchPublishTimes, type VulnerabilitySeverity } from './audit-utils';
import { plural } from './display';
import { getEnv } from './env';
import {
  type BulkAdvisory,
  fetchJson,
  fetchNodeReleases,
  fetchPnpmAdvisories,
  type NodeRelease,
  newestAged,
} from './runtimes';
import { SEVERITIES } from './security-plan';
import { compareVersionStrings, isPrerelease, parseComparableVersion, satisfiesComparators } from './versions';

const execFileAsync = promisify(execFile);

/** How a tool was installed, read from the path its binary resolves to. */
type Installer = 'volta' | 'brew' | null;

interface InstalledTool {
  version: string;
  installer: Installer;
}

/** The tools found on this machine, null when not installed, with their feeds; a feed that did not answer is null. */
export interface LocalTools {
  node: InstalledTool & { releases: NodeRelease[] | null };
  pnpm: (InstalledTool & { published: Record<string, string> | null; advisories: BulkAdvisory[] | null }) | null;
  /** `advisories` holds the severity of each advisory OSV lists against the installed version. */
  gh:
    | (InstalledTool & {
        releases: Array<{ version: string; publishedAt: number }> | null;
        advisories: VulnerabilitySeverity[] | null;
      })
    | null;
}

/** One tool as the audit shows it. */
export interface LocalToolCheck {
  name: string;
  version: string;
  /** The highest severity among the fixes the version misses; null when it misses none or was not checked. */
  severity: VulnerabilitySeverity | null;
  /** What it misses (`5 advisories, 1 high`), why it was not checked, or empty. */
  note: string;
  /** The command that gets the fixes (`update to <version>` for an install the audit cannot tell); empty when nothing is missed. */
  fix: string;
}

/** The first `name` binary on PATH outside `node_modules/.bin` folders and the folders in `skip`. */
function findOnPath(name: string, skip: string[] = []): string | null {
  for (const dir of (getEnv('PATH') ?? '').split(delimiter)) {
    if (!dir || skip.includes(dir) || dir.endsWith(`node_modules${sep}.bin`)) continue;
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

function installerOf(file: string): Installer {
  let real = file;
  try {
    real = realpathSync(file);
  } catch {
    // A broken link: read the path as found.
  }
  if (real.includes(`${sep}.volta${sep}`)) return 'volta';
  return /[\\/](Cellar|homebrew|linuxbrew)[\\/]/.test(real) ? 'brew' : null;
}

/** The first x.y.z in a binary's `--version` output; null when it does not run. */
async function versionOf(file: string, cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, ['--version'], { encoding: 'utf8', timeout: 10_000, cwd });
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

async function readNode(now: number): Promise<LocalTools['node']> {
  const version = process.version.slice(1);
  const major = parseComparableVersion(version)?.major ?? 0;
  return { version, installer: installerOf(process.execPath), releases: await fetchNodeReleases(major, now) };
}

/**
 * The pnpm a terminal starts, asked outside any project. A pnpm that switched to the workspace's
 * `packageManager` puts its own folder first on PATH, so the folder of the running pnpm is skipped.
 */
async function readPnpm(cwd: string): Promise<LocalTools['pnpm']> {
  const running = getEnv('npm_execpath');
  const file = findOnPath('pnpm', running ? [dirname(running)] : []);
  const version = file && (await versionOf(file, tmpdir()));
  if (!file || !version) return null;
  const [published, advisories] = await Promise.all([fetchPublishTimes('pnpm', cwd), fetchPnpmAdvisories(version)]);
  return { version, installer: installerOf(file), published, advisories };
}

/**
 * The severity of each advisory OSV lists against a Go module version; null when OSV does not
 * answer. OSV lists an advisory under its GHSA id and its GO id, and only the GHSA entry carries a
 * severity; one without a GHSA entry counts as moderate.
 */
async function fetchOsvSeverities(module: string, version: string): Promise<VulnerabilitySeverity[] | null> {
  const answer = await fetchJson('https://api.osv.dev/v1/query', {
    method: 'POST',
    body: JSON.stringify({ package: { name: module, ecosystem: 'Go' }, version }),
  });
  if (!answer) return null;
  type OsvVuln = { id: string; aliases?: string[]; database_specific?: { severity?: string } };
  const byGhsa = new Map<string, VulnerabilitySeverity>();
  for (const vuln of (answer as { vulns?: OsvVuln[] }).vulns ?? []) {
    const id = [vuln.id, ...(vuln.aliases ?? [])].find((alias) => alias.startsWith('GHSA-')) ?? vuln.id;
    const severity = SEVERITIES.find((level) => level === vuln.database_specific?.severity?.toLowerCase());
    if (severity || !byGhsa.has(id)) byGhsa.set(id, severity ?? 'moderate');
  }
  return [...byGhsa.values()];
}

async function readGh(): Promise<LocalTools['gh']> {
  const file = findOnPath('gh');
  const version = file && (await versionOf(file));
  if (!file || !version) return null;
  const [list, advisories] = await Promise.all([
    fetchJson('https://api.github.com/repos/cli/cli/releases?per_page=30'),
    fetchOsvSeverities('github.com/cli/cli/v2', version),
  ]);
  const releases = Array.isArray(list)
    ? list.flatMap((entry) => {
        const { tag_name, published_at } = entry as { tag_name?: string; published_at?: string };
        const publishedAt = Date.parse(published_at ?? '');
        return tag_name && !Number.isNaN(publishedAt) ? [{ version: tag_name.replace(/^v/, ''), publishedAt }] : [];
      })
    : null;
  return { version, installer: installerOf(file), releases, advisories };
}

/** Node, pnpm and gh as installed on this machine, with their release and advisory feeds, in parallel. */
export async function readLocalTools(cwd: string, now: number): Promise<LocalTools> {
  const [node, pnpm, gh] = await Promise.all([readNode(now), readPnpm(cwd), readGh()]);
  return { node, pnpm, gh };
}

/** The command that moves a tool to `target`; Homebrew picks its own version. */
function upgradeCommand(name: string, installer: Installer, target: string | undefined): string {
  if (installer === 'brew') return `brew upgrade ${name}`;
  if (!target) return 'no fixed release older than the release age yet';
  if (installer === 'volta') return `volta install ${name}@${target}`;
  return name === 'pnpm' ? `pnpm self-update ${target}` : `update to ${target}`;
}

/** The line for one tool; `missed` is null when its feed did not answer. */
function toCheck(
  name: 'node' | 'pnpm' | 'gh',
  tool: InstalledTool,
  missed: VulnerabilitySeverity[] | null,
  target: string | undefined,
  noun: [singular: string, plural: string],
): LocalToolCheck {
  if (!missed)
    return { name, version: tool.version, severity: null, note: 'not checked, no answer from the feed', fix: '' };
  if (missed.length === 0) return { name, version: tool.version, severity: null, note: '', fix: '' };
  const high = missed.filter((severity) => severity === 'critical' || severity === 'high').length;
  return {
    name,
    version: tool.version,
    severity: SEVERITIES.find((severity) => missed.includes(severity)) ?? null,
    note: `${plural(missed.length, ...noun)}${high > 0 && high < missed.length ? `, ${high} high` : ''}`,
    fix: upgradeCommand(name, tool.installer, target),
  };
}

/**
 * The security fixes each tool misses, and the version that has them: the newest one in its major
 * older than the release age. For pnpm that is the newest version no advisory affects, in its
 * major when one there has every fix.
 */
export function planLocalTools(
  tools: LocalTools,
  options: { releaseAgeMinutes: number; now: number },
): LocalToolCheck[] {
  const cutoff = options.now - options.releaseAgeMinutes * 60 * 1000;
  const { node, pnpm, gh } = tools;

  const nodeTarget = node.releases ? newestAged(node.version, node.releases, cutoff) : undefined;
  const securityReleases = (node.releases ?? []).filter(
    (release) =>
      release.security &&
      nodeTarget &&
      compareVersionStrings(release.version, node.version) > 0 &&
      compareVersionStrings(release.version, nodeTarget.version) <= 0,
  );
  const checks = [
    toCheck(
      'node',
      node,
      node.releases && securityReleases.map((): VulnerabilitySeverity => 'high'),
      nodeTarget?.version,
      ['security release', 'security releases'],
    ),
  ];

  if (pnpm) {
    const affecting = (version: string) =>
      (pnpm.advisories ?? []).filter((advisory) => satisfiesComparators(version, advisory.vulnerable_versions));
    const fixed = Object.entries(pnpm.published ?? {})
      .map(([version, time]) => ({ version, publishedAt: Date.parse(time) }))
      .filter(
        (release) =>
          parseComparableVersion(release.version) &&
          !isPrerelease(release.version) &&
          release.publishedAt <= cutoff &&
          compareVersionStrings(release.version, pnpm.version) > 0 &&
          affecting(release.version).length === 0,
      )
      .sort((a, b) => compareVersionStrings(b.version, a.version));
    const major = parseComparableVersion(pnpm.version)?.major;
    const target = fixed.find((release) => parseComparableVersion(release.version)?.major === major) ?? fixed[0];
    const missed = pnpm.advisories && pnpm.published && affecting(pnpm.version).map((advisory) => advisory.severity);
    checks.push(toCheck('pnpm', pnpm, missed, target?.version, ['advisory', 'advisories']));
  }

  if (gh) {
    const target = gh.releases ? newestAged(gh.version, gh.releases, cutoff) : undefined;
    checks.push(toCheck('gh', gh, gh.advisories, target?.version, ['advisory', 'advisories']));
  }

  return checks;
}
