import { resolveUpstream } from '../config/load';
import type { RuntimeConfig } from '../config/types';
import { version } from '../utils/display';
import { getShortSha, git, isAncestor } from '../utils/git';
import { readReleaseAgeMinutes } from '../utils/pnpm';
import { compareVersions, parseComparableVersion } from '../utils/versions';
import { compareUpstreamOverrides, hasBlockingOverrideChanges } from './config-gate';
import { configFile } from './managed-files';
import type { UpstreamContext, UpstreamOverridesReport } from './model';

const cliPackage = '@cellajs/cli';

/** The `@cellajs/cli` range in upstream's root package.json at `ref`, or null when it names none. */
export async function readUpstreamCliRange(repoPath: string, ref: string): Promise<string | null> {
  const source = await git(['show', `${ref}:package.json`], repoPath, { ignoreErrors: true });
  if (!source) return null;
  try {
    const pkg = JSON.parse(source) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.devDependencies?.[cliPackage] ?? pkg.dependencies?.[cliPackage] ?? null;
  } catch {
    return null;
  }
}

/**
 * The follow-up line for an app that delays fresh releases (`minimumReleaseAge`): the exact
 * `minimumReleaseAgeExclude` entry that lets the asked-for version install before it ages.
 */
export function releaseAgeExcludeHint(range: string): string {
  const version = range.match(/\d+\S*/)?.[0] ?? range;
  return `  pnpm delays fresh releases (minimumReleaseAge): if the install is refused, add '${cliPackage}@${version}' to minimumReleaseAgeExclude in pnpm-workspace.yaml.`;
}

/**
 * The error message when `running` is older than the lowest version `range` admits, else null.
 * A range with no lower bound (`<1.0.0`, `workspace:*`, `link:…`, `a || b`) never blocks.
 */
export function cliVersionMismatch(running: string, range: string): string | null {
  if (/^\s*(<|>(?!=))/.test(range)) return null;
  const required = parseComparableVersion(range);
  const current = parseComparableVersion(running);
  if (!required || !current || compareVersions(current, required) >= 0) return null;
  return [
    `upstream needs ${cliPackage} ${range}, this is ${running}: an older CLI misses fixes to the upgrade itself.`,
    `  update it, commit, then rerun: pnpm add -D -w '${cliPackage}@${range}'`,
  ].join('\n');
}

/**
 * Stop when upstream's root package.json names a newer CLI than this one. An upgrade bumps the app's
 * `@cellajs/cli` along with its other packages, so each upgrade runs on the CLI from before it: a fix
 * to analyze or upgrade would reach an app one upgrade late, and that run would miss what the fix reports.
 */
export async function assertCliVersion(repoRoot: string, upstreamRef: string): Promise<void> {
  const range = await readUpstreamCliRange(repoRoot, upstreamRef);
  const mismatch = range ? cliVersionMismatch(version, range) : null;
  if (!range || !mismatch) return;
  const delayed = (await readReleaseAgeMinutes(repoRoot)) > 0;
  throw new Error(delayed ? `${mismatch}\n${releaseAgeExcludeHint(range)}` : mismatch);
}

/**
 * Thrown when the upstream commit is behind the app's last upgrade point: the app already has it,
 * and merging it would stage a revert. `cella upgrade` ends as a no-op on it, unless the run pinned
 * the ref itself (`--ref`).
 */
export class BehindUpgradePointError extends Error {}

/**
 * Stop when the upstream commit is behind the upgrade point (an earlier run went further with `--ref`
 * or `--track branch`): it would stage a revert of everything after it as if upstream had undone it.
 */
export async function assertAheadOfUpgradePoint(config: RuntimeConfig, upstream: UpstreamContext): Promise<void> {
  const { repoRoot } = config;
  const { commit, mergeBase, releaseTag } = upstream;
  if (commit.hash === mergeBase || !(await isAncestor(repoRoot, commit.hash, mergeBase))) return;

  const [upstreamShort, upgradePointShort] = await Promise.all([getShortSha(repoRoot, commit.hash), getShortSha(repoRoot, mergeBase)]);
  const { branchRef } = resolveUpstream(config);
  const hint = config.ref
    ? 'Pick a newer --ref.'
    : releaseTag
      ? `Nothing to upgrade until a release past ${upgradePointShort}; to follow the tip instead, run with --track branch.`
      : `Nothing to upgrade until '${branchRef}' moves past ${upgradePointShort}.`;
  const label = releaseTag ?? (config.ref ? `--ref ${config.ref}` : upstream.ref);
  throw new BehindUpgradePointError(
    `upstream ${label} (${upstreamShort}) is behind the last upgrade at ${upgradePointShort}: the app already ` +
      `has it, and merging it would revert the upstream changes after it.\n${hint}`,
  );
}

/**
 * Thrown before a new merge starts when upstream changed its CLI config in ways the app config
 * does not follow. Carries the report so the caller can print it.
 */
export class UpstreamConfigChangedError extends Error {
  readonly report: UpstreamOverridesReport;

  constructor(report: UpstreamOverridesReport) {
    super(
      [
        'upstream changed its CLI config and yours does not follow it: stopped before the merge, nothing changed.',
        `  add or drop the entries that fit your app in ${configFile}, commit, then rerun.`,
        '  to merge with your config as it stands, rerun with --keep-config.',
      ].join('\n'),
    );
    this.report = report;
  }
}

/**
 * Stop a new merge when upstream changed its CLI config since the upgrade point in ways the app
 * config does not follow. The merge runs on the app's config, so a path upstream newly ignores or
 * pins would arrive as an ordinary merged file (upstream renamed an ignored folder, the app's list
 * still names the old one). `--keep-config` skips the gate; an unreadable upstream config or a
 * failed comparison never stops the run, and a report of moved entries alone prints with the merge result.
 */
export async function assertUpstreamConfigFollowed(config: RuntimeConfig, upstream: UpstreamContext): Promise<void> {
  if (config.keepConfig) return;
  const report = await compareUpstreamOverrides(config.repoRoot, upstream.mergeBase, upstream.ref, config).catch(() => undefined);
  if (report && hasBlockingOverrideChanges(report)) throw new UpstreamConfigChangedError(report);
}
