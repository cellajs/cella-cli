/**
 * Analyze service: a dry run of sync that shows what would change without applying.
 */

import type { MergeResult, RuntimeConfig } from '../config/types';
import {
  createSpinner,
  type LinkOptions,
  printAnalysisFileGroups,
  printEngineReports,
  spinnerSuccess,
  writeStdout,
} from '../utils/display';
import { CONFIG_FILE } from '../utils/managed-files';
import { runEngineWithSpinner } from './merge-engine';
import { printMigrationNotesLine } from './migrate';
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

  const linkOptions: LinkOptions = {
    upstreamGitHubUrl: result.upstreamGitHubUrl,
    upstreamBranch: result.upstreamBranch,
    fileLinkMode: config.settings.fileLinkMode,
    forkPath: config.forkPath,
  };

  // File lists first (analyze shows them for review); the summary and shared reports close the output.
  printAnalysisFileGroups(result.files, linkOptions, result);

  printEngineReports(result, 'analysis summary');
  await reportReviewPage(config.forkPath, result, 'analyze');

  await printMigrationNotesLine(config, result);

  console.info();

  return result;
}
