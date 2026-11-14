import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { createSpinner, type NextStep, plural, printNextSteps, printStep, writeStdout } from '../utils/display';
import { gitHubRepo, readRemoteUrl } from '../utils/git';
import { alignmentsStep } from './align';
import { printAnalysisFileGroups } from './analyze-report';
import { changedFromUpstream, classifiedResult, classifyUpgrade, enrichChangeInfo } from './classify';
import { assertAheadOfUpgradePoint, assertCliVersion } from './gates';
import { configFile } from './managed-files';
import type { MergeResult } from './model';
import {
  printCheckoutStep,
  printMaskingPinWarning,
  printSummary,
  printUpstreamOverrideChanges,
  printUpstreamStep,
  readUpstreamReports,
} from './report';
import { reportReviewPage, reviewStep } from './review-page';
import { ensureUpgradePoint, readAlignmentsInRange, readUpgradeRange } from './upgrade-point';
import { fetchUpstream, resolveUpstreamRef } from './upstream-ref';

const scopeStatuses = {
  all: new Set(['ahead', 'drifted', 'diverged']),
  risk: new Set(['drifted', 'diverged']),
  protected: new Set(['ahead']),
};

/** Which files `--list` and `--json` print. */
type AnalyzeScope = keyof typeof scopeStatuses;

/**
 * Scope filter. Protected files upstream also changed (`upstreamChanged`, status `pinned` or
 * `ignored`) ride along in `all` and `protected`: they are the pins most worth reviewing. So do
 * ignored files only upstream changed (`upstreamOnly`), and the CLI config when upstream's
 * `pinned`, `ignored` or `packageJsonKeys` changed in ways the app config does not follow.
 */
function filterByScope(result: MergeResult, scope: AnalyzeScope): MergeResult['files'] {
  const statuses = scopeStatuses[scope];
  if (scope === 'risk') return result.files.filter((f) => statuses.has(f.status));
  const overridesChanged = result.upstreamOverrides?.type === 'changes';
  return result.files.filter(
    (f) =>
      statuses.has(f.status) ||
      f.upstreamChanged === true ||
      f.upstreamOnly === true ||
      (overridesChanged && f.path === configFile),
  );
}

/** How analyze prints: one path per line or JSON for tooling, the scope of those, and large groups in full. */
export interface AnalyzeOutput {
  list?: boolean;
  json?: boolean;
  scope?: AnalyzeScope;
  all?: boolean;
}

/**
 * The `analyze` command: a dry run of the upgrade that classifies every file from git refs and
 * prints what an upgrade would change. The app's branches and working tree stay unchanged; like
 * upgrade, it fetches upstream, and an app with no common history with upstream yet gets the local
 * graft and ref its comparison needs.
 */
export async function runAnalyze(config: RuntimeConfig, output: AnalyzeOutput = {}): Promise<MergeResult> {
  const { repoRoot } = config;
  createSpinner('starting analysis...');

  await printCheckoutStep(repoRoot);
  await fetchUpstream(config);
  const pick = await resolveUpstreamRef(config);
  await ensureUpgradePoint(repoRoot, 'HEAD', pick.ref);
  const upstream = await readUpgradeRange(config, pick);
  await printUpstreamStep(config, upstream);

  await assertCliVersion(repoRoot, upstream.ref);
  await assertAheadOfUpgradePoint(config, upstream);

  const alignments = await readAlignmentsInRange(repoRoot, upstream);
  const files = await classifyUpgrade(config, upstream);
  await enrichChangeInfo(repoRoot, files, upstream.mergeBase, 'HEAD', upstream.ref);
  const result: MergeResult = {
    ...classifiedResult(files),
    // The files git merges, each of which may conflict.
    conflicts: files.filter((file) => file.resolution === 'merge').map((file) => file.path),
    ...(await readUpstreamReports(config, upstream, files)),
    // The arrivals open only once the upgrade lands.
    alignments,
  };
  printStep('analyzed', `${plural(files.length, 'file')}${pc.dim(' · dry run, branches and working tree unchanged')}`);

  const scopedFiles = filterByScope(result, output.scope ?? 'all');

  if (output.json) {
    const overrides = result.upstreamOverrides?.type === 'changes' ? result.upstreamOverrides : undefined;
    const out = scopedFiles.map((f) => ({
      path: f.path,
      status: f.status,
      changedAt: f.changedAt ?? null,
      changedCommit: f.changedCommit ?? null,
      upstreamChangedAt: f.upstreamChangedAt ?? null,
      upstreamCommit: f.upstreamCommit ?? null,
      upstreamChanged: f.upstreamChanged ?? false,
      upstreamChangedLines: f.upstreamChangedLines ?? null,
      upstreamLinesAbsent: f.upstreamLinesAbsent ?? null,
      upstreamOnly: f.upstreamOnly ?? false,
      // Only on the CLI config: upstream override entries and packageJsonKeys the app config does not follow
      upstreamOverrides:
        overrides && f.path === configFile
          ? { pinned: overrides.pinned, ignored: overrides.ignored, packageJsonKeys: overrides.packageJsonKeys }
          : null,
    }));
    writeStdout(JSON.stringify(out, null, 2));
    return result;
  }

  if (output.list) {
    for (const file of scopedFiles) {
      writeStdout(file.path);
    }
    return result;
  }

  // File sections first, ordered by how much they need you; the summary and the next steps close the output.
  printAnalysisFileGroups(result, {
    links: {
      upstreamGitHubUrl: result.upstreamGitHubUrl,
      upstreamSha: result.upstreamCommit?.hash,
      appGitHubUrl: gitHubRepo(await readRemoteUrl(repoRoot, 'origin'))?.url,
      fileLinkMode: config.fileLinkMode,
      repoRoot,
    },
    all: output.all,
    ignored: config.ignored,
    pinned: config.pinned,
  });
  printUpstreamOverrideChanges(result);
  printMaskingPinWarning(result.files);
  printSummary(result.summary, 'analysis summary');

  const steps: NextStep[] = [];
  const review = await reportReviewPage(repoRoot, result, 'analyze');
  if (review) steps.push(reviewStep(review));
  const upgrade = upgradeStep(result);
  if (upgrade) steps.push(upgrade);
  const align = await alignmentsStep(config, {
    ref: upstream.commit.hash,
    open: alignments.open,
    arriving: alignments.arrived,
  });
  if (align) steps.push(align);
  printNextSteps(steps);

  return result;
}

/** The `upgrade` step: what the upgrade would change, left out when upstream has nothing new. */
function upgradeStep(result: MergeResult): NextStep | undefined {
  if (!result.upstreamCommitCount) return undefined;
  const changed = changedFromUpstream(result.files);
  const merges = changed.filter((file) => file.resolution === 'merge').length;
  const changes = [
    changed.length > merges ? `${changed.length - merges} update` : '',
    merges > 0 ? `${merges} merge` : '',
  ].filter(Boolean);
  return {
    label: 'upgrade',
    line: 'pnpm cella upgrade',
    details: [
      pc.dim(
        `commits on a fresh branch, a rerun opens the PR · ${changes.length > 0 ? changes.join(', ') : 'no file changes'}`,
      ),
    ],
  };
}
