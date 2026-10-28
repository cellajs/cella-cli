/**
 * Analyze service: a dry run of sync that shows what would change without applying.
 */

import type { MergeResult, RuntimeConfig } from '../config/types';
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
import { CONFIG_FILE } from '../utils/managed-files';
import { alignmentsStep } from './align';
import { printAnalysisFileGroups } from './analyze-report';
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
 * overrides changed in ways the fork config does not follow.
 */
function filterByScope(result: MergeResult, scope: 'all' | 'risk' | 'protected'): MergeResult['files'] {
  const statuses = scopeStatuses[scope];
  if (scope === 'risk') return result.files.filter((f) => statuses.has(f.status));
  const overridesChanged = result.upstreamOverrides?.kind === 'changes';
  return result.files.filter(
    (f) =>
      statuses.has(f.status) ||
      f.upstreamChanged === true ||
      f.upstreamOnly === true ||
      (overridesChanged && f.path === CONFIG_FILE),
  );
}

export async function runAnalyze(config: RuntimeConfig): Promise<MergeResult> {
  createSpinner('starting analysis...');

  const result = await runEngineWithSpinner(config, false);

  spinnerSuccess();

  const scopedFiles = filterByScope(result, config.scope ?? 'all');

  if (config.json) {
    const overrides = result.upstreamOverrides?.kind === 'changes' ? result.upstreamOverrides : undefined;
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
      // Only on the CLI config: upstream override entries and packageJsonKeys the fork config does not follow
      upstreamOverrides:
        overrides && f.path === CONFIG_FILE
          ? { pinned: overrides.pinned, ignored: overrides.ignored, packageJsonKeys: overrides.packageJsonKeys }
          : null,
    }));
    writeStdout(JSON.stringify(out, null, 2));
    return result;
  }

  if (config.list) {
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
      forkGitHubUrl: await readOriginGitHubUrl(config.forkPath),
      fileLinkMode: config.settings.fileLinkMode,
      forkPath: config.forkPath,
    },
    all: config.all,
    overrides: config.overrides,
  });
  printUpstreamOverrideChanges(result);
  printMaskingPinWarning(result.files);
  printSummary(result.summary, 'analysis summary');

  const steps: NextStep[] = [];
  const review = await reportReviewPage(config.forkPath, result, 'analyze');
  if (review) steps.push(reviewStep(review));
  const sync = syncStep(result);
  if (sync) steps.push(sync);
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
function syncStep(result: MergeResult): NextStep | undefined {
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
