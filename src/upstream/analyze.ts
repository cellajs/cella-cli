/**
 * Analyze command: a dry run of the upgrade that shows what would change without applying.
 */

import type { AnalyzeScope, MergeResult, RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import {
  createSpinner,
  type NextStep,
  printMaskingPinWarning,
  printNextSteps,
  printSummary,
  printUpstreamOverrideChanges,
  spinnerSuccess,
  writeStdout,
} from '../utils/display';
import { alignmentsStep } from './align';
import { printAnalysisFileGroups } from './analyze-report';
import { configFile } from './managed-files';
import { readOriginGitHubUrl, runEngineWithSpinner } from './merge-engine';
import { reportReviewPage, reviewStep } from './review-page';

const scopeStatuses: Record<'all' | 'risk' | 'protected', Set<string>> = {
  all: new Set(['ahead', 'drifted', 'diverged']),
  risk: new Set(['drifted', 'diverged']),
  protected: new Set(['ahead']),
};

/**
 * Scope filter. Protected files upstream also changed (`upstreamChanged`, status `pinned` or
 * `ignored`) ride along in `all` and `protected`: they are the pins most worth reviewing. So do
 * ignored files only upstream changed (`upstreamOnly`), and the CLI config when upstream's
 * `pinned`, `ignored` or `packageJsonKeys` changed in ways the app config does not follow.
 */
function filterByScope(result: MergeResult, scope: 'all' | 'risk' | 'protected'): MergeResult['files'] {
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

export async function runAnalyze(config: RuntimeConfig, output: AnalyzeOutput = {}): Promise<MergeResult> {
  createSpinner('starting analysis...');

  const result = await runEngineWithSpinner(config, false);

  spinnerSuccess();

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
      appGitHubUrl: await readOriginGitHubUrl(config.repoRoot),
      fileLinkMode: config.fileLinkMode,
      repoRoot: config.repoRoot,
    },
    all: output.all,
    ignored: config.ignored,
    pinned: config.pinned,
  });
  printUpstreamOverrideChanges(result);
  printMaskingPinWarning(result.files);
  printSummary(result.summary, 'analysis summary');

  const steps: NextStep[] = [];
  const review = await reportReviewPage(config.repoRoot, result, 'analyze');
  if (review) steps.push(reviewStep(review));
  const upgrade = upgradeStep(result);
  if (upgrade) steps.push(upgrade);
  const align =
    result.alignments && result.upstreamCommit
      ? await alignmentsStep(config, {
          ref: result.upstreamCommit.hash,
          open: result.alignments.open,
          arriving: result.alignments.arrived,
        })
      : undefined;
  if (align) steps.push(align);
  printNextSteps(steps);

  return result;
}

/** The `upgrade` step: what the upgrade would change, left out when upstream has nothing new. */
function upgradeStep(result: MergeResult): NextStep | undefined {
  if (!result.upstreamCommitCount) return undefined;
  const { behind, diverged, renamed } = result.summary;
  const changes = [
    behind > 0 ? `${behind} update` : '',
    diverged > 0 ? `${diverged} merge` : '',
    renamed > 0 ? `${renamed} rename` : '',
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
