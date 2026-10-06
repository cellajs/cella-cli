/**
 * Forks service: runs the sync service inside configured local fork repositories
 * from the upstream template. Selecting a fork runs sync immediately (plus
 * packages when enabled), then returns to the selection menu.
 */

import { resolve } from 'node:path';
import process from 'node:process';
import { Separator, select } from '@inquirer/prompts';
import type { ForkConfig, RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { loadConfig, resolveUpstream } from '../utils/config';
import { MENU_DIVIDER } from '../utils/display';
import { getCommitInfo, getCurrentBranch, getStoredSyncRef, getWorkingTreeChangeCount } from '../utils/git';
import { printNoForksHint, resolveForkBasePath, validateForkPath } from './fork-utils';
import { runSyncCommand } from './sync';

/** Status info gathered from a fork repository */
interface ForkStatus {
  branch: string;
  dirty: number;
  lastSync: { date: string; message: string } | null;
}

/** Git status info for a fork: branch, dirty state, last sync. */
async function gatherForkStatus(forkPath: string): Promise<ForkStatus> {
  const [branch, dirty, syncRef] = await Promise.all([
    getCurrentBranch(forkPath).catch(() => 'unknown'),
    getWorkingTreeChangeCount(forkPath).catch(() => 0),
    getStoredSyncRef(forkPath),
  ]);

  let lastSync: { date: string; message: string } | null = null;
  if (syncRef) {
    const commitInfo = await getCommitInfo(forkPath, syncRef).catch(() => null);
    lastSync = { date: commitInfo?.date ?? 'unknown', message: commitInfo?.message ?? '' };
  }

  return { branch, dirty, lastSync };
}

function formatForkChoice(name: string, status: ForkStatus | null): string {
  if (!status) return name;

  // Sync: date and truncated commit message.
  let syncPart: string;
  if (status.lastSync) {
    const msg =
      status.lastSync.message.length > 36 ? `${status.lastSync.message.slice(0, 36)}…` : status.lastSync.message;
    syncPart = pc.dim(`${status.lastSync.date}`);
    if (msg) syncPart += pc.dim(` '${msg}'`);
  } else {
    syncPart = pc.dim('never synced');
  }

  const dirtyPart = status.dirty > 0 ? pc.yellow(`${status.dirty} uncommitted`) : '';

  const parts = [name, pc.dim(`[${status.branch}]`), syncPart];
  if (dirtyPart) parts.push(dirtyPart);

  return parts.join(pc.dim(' · '));
}

/** Fork choices with live status info, gathered in parallel. */
async function buildForkChoices(
  forks: ForkConfig[],
  basePath: string,
): Promise<Array<{ value: string; name: string; disabled?: string }>> {
  const validated = forks.map((fork) => validateForkPath(fork, basePath, true));

  const statusEntries = await Promise.all(
    validated
      .filter((v) => v.valid)
      .map(async (v) => {
        const status = await gatherForkStatus(v.resolvedPath);
        return { path: v.fork.localPath, status };
      }),
  );
  const statusMap = new Map(statusEntries.map((e) => [e.path, e.status]));

  return validated.map((v) => {
    if (!v.valid) {
      return {
        value: v.fork.localPath,
        name: `${v.fork.name}  ${pc.dim(v.fork.localPath)}`,
        disabled: v.error,
      };
    }
    return {
      value: v.fork.localPath,
      name: formatForkChoice(v.fork.name, statusMap.get(v.fork.localPath) ?? null),
    };
  });
}

/** Sync a single fork by running the same service flow the fork owner would run locally. */
async function syncFork(config: RuntimeConfig, fork: ForkConfig, forkPath: string): Promise<void> {
  console.info();
  console.info(pc.cyan(`syncing to ${fork.name}...`));
  console.info(pc.dim(`path: ${forkPath}`));
  console.info();

  const forkConfig = await loadConfig(forkPath);

  const { branchRef } = resolveUpstream(forkConfig.settings);
  const upstreamRef = branchRef;

  const forkRuntimeConfig: RuntimeConfig = {
    ...forkConfig,
    forkPath,
    upstreamRef,
    service: 'sync',
    logFile: config.logFile,
    list: false,
    json: false,
    verbose: config.verbose,
    hard: config.hard,
    keepConfig: config.keepConfig,
  };

  await runSyncCommand(forkRuntimeConfig);
}

export async function runForks(config: RuntimeConfig): Promise<void> {
  const forks = config.forks ?? [];

  if (forks.length === 0) {
    printNoForksHint('add forks to your config:');
    return;
  }

  // --fork is the non-interactive mode.
  if (config.fork) {
    const match = forks.find((f) => f.name === config.fork);
    if (!match) {
      throw new Error(`fork '${config.fork}' not found in config`);
    }
    const resolvedPath = resolve(await resolveForkBasePath(config.forkPath), match.localPath);
    await syncFork(config, match, resolvedPath);
    return;
  }

  // Choices are rebuilt each iteration so the menu reflects updated status.
  const forkBasePath = await resolveForkBasePath(config.forkPath);
  while (true) {
    const choices = await buildForkChoices(forks, forkBasePath);
    const forkChoices = [...choices, new Separator(MENU_DIVIDER), { value: '_exit', name: pc.dim('exit') }];

    const selectedPath = await select<string>({
      message: 'select fork to sync:',
      choices: forkChoices,
      loop: false,
    });

    if (selectedPath === '_exit') {
      process.exit(0);
    }

    const resolvedForkPath = resolve(forkBasePath, selectedPath);
    const selectedFork = forks.find((f) => f.localPath === selectedPath);
    if (!selectedFork) {
      console.error(pc.red(`fork '${selectedPath}' not found in config`));
      continue;
    }

    await syncFork(config, selectedFork, resolvedForkPath);

    console.info();
  }
}
