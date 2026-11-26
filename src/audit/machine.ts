/**
 * The tools this machine works on the workspace with: the Node that runs it, the pnpm a terminal
 * starts, and gh. Each is checked against its feeds (see feeds.ts) for the security fixes it
 * misses. The audit only reports them, with the upgrade command that fits how the tool was installed.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';
import { plural } from '../utils/display';
import { getEnv, getEnvSnapshot } from '../utils/env';
import { type VulnerabilitySeverity, worstSeverity } from '../utils/pnpm';
import type { Feeds } from './feeds';
import { newestAged } from './runtimes';

const execFileAsync = promisify(execFile);

/** How a tool was installed, read from the path its binary resolves to. */
type Installer = 'volta' | 'brew' | null;

interface InstalledTool {
  version: string;
  installer: Installer;
}

/** The tools found on this machine; null when not installed. */
export interface LocalTools {
  node: InstalledTool;
  pnpm: InstalledTool | null;
  gh: InstalledTool | null;
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

/** The binary's version (the first x.y.z its `--version` prints) and installer; null when it is missing or does not run. */
async function readTool(
  file: string | null,
  options?: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<InstalledTool | null> {
  if (!file) return null;
  try {
    const { stdout } = await execFileAsync(file, ['--version'], { encoding: 'utf8', timeout: 10_000, ...options });
    const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
    return version ? { version, installer: installerOf(file) } : null;
  } catch {
    return null;
  }
}

/**
 * Node, pnpm and gh as installed on this machine. pnpm is the one a terminal starts, asked outside
 * any project: a pnpm that switched to the workspace's `packageManager` puts its own folder first
 * on PATH, so the folder of the running pnpm is skipped.
 */
export async function readLocalTools(): Promise<LocalTools> {
  const running = getEnv('npm_execpath');
  const [pnpm, gh] = await Promise.all([
    readTool(findOnPath('pnpm', running ? [dirname(running)] : []), {
      cwd: tmpdir(),
      // A `packageManager` field planted in the temp folder or a parent of it would make pnpm switch to that release
      env: {
        ...getEnvSnapshot(),
        pnpm_config_pm_on_fail: 'ignore',
        npm_config_manage_package_manager_versions: 'false',
      },
    }),
    readTool(findOnPath('gh')),
  ]);
  return { node: { version: process.version.slice(1), installer: installerOf(process.execPath) }, pnpm, gh };
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
    severity: worstSeverity(missed),
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
  feeds: Feeds,
  options: { releaseAgeMinutes: number; now: number },
): LocalToolCheck[] {
  const cutoff = options.now - options.releaseAgeMinutes * 60 * 1000;
  const { node, pnpm, gh } = tools;

  const nodeTarget = feeds.node ? newestAged(node.version, feeds.node, cutoff) : undefined;
  const securityReleases = (feeds.node ?? []).filter(
    (release) =>
      release.security && nodeTarget && semver.satisfies(release.version, `>${node.version} <=${nodeTarget}`),
  );
  const checks = [
    toCheck('node', node, feeds.node && securityReleases.map((): VulnerabilitySeverity => 'high'), nodeTarget, [
      'security release',
      'security releases',
    ]),
  ];

  if (pnpm) {
    const advisories = feeds.pnpmAdvisories ?? [];
    const affecting = (version: string) =>
      advisories.filter((advisory) => semver.satisfies(version, advisory.vulnerable_versions));
    const fixed = (feeds.pnpm ?? [])
      .filter((release) => release.publishedAt <= cutoff && affecting(release.version).length === 0)
      .map((release) => release.version);
    const target =
      semver.maxSatisfying(fixed, `>${pnpm.version} <${semver.major(pnpm.version) + 1}`) ??
      semver.maxSatisfying(fixed, `>${pnpm.version}`);
    const missed = feeds.pnpmAdvisories && feeds.pnpm && affecting(pnpm.version).map((advisory) => advisory.severity);
    checks.push(toCheck('pnpm', pnpm, missed, target ?? undefined, ['advisory', 'advisories']));
  }

  if (gh) {
    const target = feeds.gh ? newestAged(gh.version, feeds.gh, cutoff) : undefined;
    checks.push(toCheck('gh', gh, feeds.ghAdvisories, target, ['advisory', 'advisories']));
  }

  return checks;
}
