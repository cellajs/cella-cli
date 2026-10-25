/**
 * Analyze service: a dry run of sync that shows what would change without applying.
 */

import type { MergeResult, RuntimeConfig } from '../config/types';
import {
  createSpinner,
  printMaskingPinWarning,
  printSummary,
  printUpstreamOverrideChanges,
  spinnerSuccess,
  writeStdout,
} from '../utils/display';
import { CONFIG_FILE } from '../utils/managed-files';
import { printAlignmentsLine } from './align';
import { printAnalysisFileGroups } from './analyze-report';
import { readOriginGitHubUrl, runEngineWithSpinner } from './merge-engine';
import { reportReviewPage } from './review-page';

const scopeStatuses: Record<'all' | 'risk' | 'protected', Set<string>> = {
  all: new Set(['ahead', 'drifted', 'diverged']),
  risk: new Set(['drifted', 'diverged']),
  protected: new Set(['ahead']),
};

/**
 * Scope filter. Protected files upstream also changed (`upstreamChanged`, status `pinned` or
 * `ignored`) ride along in `all` and `protected`: they are the pins most worth reviewing. So do
 * ignored files only upstream changed (`upstreamOnly`), and the sync config when upstream's
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
      // Only on the sync config: upstream override entries and packageJsonSync keys the fork config does not follow
      upstreamOverrides:
        overrides && f.path === CONFIG_FILE
          ? { pinned: overrides.pinned, ignored: overrides.ignored, packageJsonSync: overrides.packageJsonSync }
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

  // File sections first, ordered by how much they need you; the summary and the review page close the output.
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
  await reportReviewPage(config.forkPath, result, 'analyze');

  await printAlignmentsLine(config, result);

  console.info();

  return result;
}
