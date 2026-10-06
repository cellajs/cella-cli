/**
 * Analyze service: a dry run of sync that shows what would change without applying.
 * Runs the same merge engine as sync and discards the result.
 */

import { basename } from 'node:path';
import type { MergeResult, RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { gitDiffFile, openDiffInBrowser } from '../utils/diff';
import {
  checkMark,
  createSpinner,
  type LinkOptions,
  printAnalysisFileGroups,
  printEngineReports,
  printLogFileReport,
  spinnerSuccess,
  writeStdout,
} from '../utils/display';
import { CONFIG_FILE } from '../utils/managed-files';
import { runEngineWithSpinner } from './merge-engine';
import { printMigrationNotesLine } from './migrate';

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

function findTargetFile(files: MergeResult['files'], targetPath: string) {
  const exact = files.find((f) => f.path === targetPath);
  if (exact) return exact;

  const normalized = targetPath.replace(/^\.\//, '');
  return files.find((f) => f.path === normalized);
}

function printUnifiedDiff(config: RuntimeConfig, filePath: string): void {
  // Label the upstream side 'cella/' and the local side with the repo's folder name
  // so the diff reads cella/<path> vs <fork>/<path>, not opaque a/ and b/.
  const diff = gitDiffFile(config.forkPath, `${config.upstreamRef}..HEAD`, filePath, {
    dstPrefix: basename(config.forkPath),
  });
  writeStdout(diff.toString());
}

export async function runAnalyze(config: RuntimeConfig): Promise<MergeResult> {
  createSpinner('starting analysis...');

  const result = await runEngineWithSpinner(config, false);

  spinnerSuccess();

  const scopedFiles = filterByScope(result, config.scope ?? 'all');

  if (config.diff) {
    const file = findTargetFile(scopedFiles, config.diff) ?? findTargetFile(result.files, config.diff);
    if (!file) throw new Error(`file not found in analysis results: ${config.diff}`);
    printUnifiedDiff(config, file.path);
    return result;
  }

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

  if (config.openDiff) {
    const file = findTargetFile(scopedFiles, config.openDiff) ?? findTargetFile(result.files, config.openDiff);
    if (!file) throw new Error(`file not found in analysis results: ${config.openDiff}`);

    // Diff the upstream ref against the working tree (single ref, no range) so the
    // rendered page includes uncommitted local changes: a live view of the file as it stands.
    const patch = gitDiffFile(config.forkPath, config.upstreamRef, file.path);
    if (patch.length === 0) {
      console.info(`${checkMark} ${file.path} is identical to upstream`);
      return result;
    }

    const pagePath = await openDiffInBrowser(
      patch.toString(),
      {
        filePath: file.path,
        srcLabel: 'cella',
        dstLabel: basename(config.forkPath),
        note: 'local working tree',
      },
      config.forkPath,
    );
    console.info(`${checkMark} opened browser diff for ${file.path}`);
    console.info(pc.dim(`  ${pagePath}`));
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

  await printMigrationNotesLine(config, result);

  printLogFileReport(config, result.files);

  console.info();

  return result;
}
