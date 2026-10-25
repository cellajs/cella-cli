#!/usr/bin/env tsx
/**
 * Cella CLI main entry point: resolves the fork path, loads the config,
 * parses the command line and routes to the selected service.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseCli } from './cli';
import type { CellaCliConfig, RuntimeConfig, SyncService } from './config/types';
import { runAlign } from './services/align';
import { runAnalyze } from './services/analyze';
import { runAudit } from './services/audit';
import { runContributions } from './services/contributions';
import { runForks } from './services/forks';
import { runStats } from './services/stats';
import { runBranchStats } from './services/stats-since';
import { runSyncCommand } from './services/sync';
import pc from './utils/colors';
import { loadConfig } from './utils/config';
import { getEnv } from './utils/env';
import { errorMessage } from './utils/errors';

/**
 * The fork path: the CELLA_FORK_PATH environment variable when set, else the current
 * working directory. A cwd inside cli/cella (pnpm --filter) resolves up to the fork root.
 */
function getForkPath(): string {
  const envPath = getEnv('CELLA_FORK_PATH');
  if (envPath) {
    const resolved = resolve(envPath);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`CELLA_FORK_PATH is not a valid directory: ${resolved}`);
    }
    return resolved;
  }

  let cwd = process.cwd();

  if (cwd.endsWith('/cli/cella') || cwd.endsWith('\\cli\\cella')) {
    cwd = resolve(cwd, '../..');
  }

  return cwd;
}

/**
 * Pre-flight check before running a service: verifies the path is a git repository.
 * The sync service cuts its own temporary branch from the trunk and owns its own
 * clean/resume state, so neither the current branch nor a dirty tree blocks a run.
 */
function preflight(forkPath: string): void {
  if (!existsSync(join(forkPath, '.git'))) {
    throw new Error(`not a git repository: ${forkPath}`);
  }
}

/** What each service runs once the command line is parsed. */
const services: Record<SyncService, (config: RuntimeConfig) => Promise<unknown>> = {
  analyze: runAnalyze,
  sync: runSyncCommand,
  align: runAlign,
  audit: runAudit,
  forks: runForks,
  contributions: runContributions,
  stats: async (config) => {
    if (config.md && !config.since) throw new Error('--md goes with --since <ref>');
    if (!config.since) return runStats(config);
    return runBranchStats(config, config.since);
  },
};

function isHelpOrVersionRequest(): boolean {
  return (
    process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') ||
    process.argv[2] === 'help'
  );
}

async function main(): Promise<void> {
  try {
    const forkPath = getForkPath();

    if (isHelpOrVersionRequest()) {
      await parseCli({ settings: { upstreamUrl: '', upstreamBranch: 'main' } } as CellaCliConfig, forkPath);
      return;
    }

    const userConfig = await loadConfig(forkPath);

    const config = await parseCli(userConfig, forkPath);

    // Services that operate on other fork paths skip the local-repo preflight.
    if (!['audit', 'forks', 'contributions', 'stats'].includes(config.service)) {
      preflight(forkPath);
    }

    await services[config.service](config);

    console.info();
  } catch (error) {
    console.error();
    console.error(`${pc.red('✗')} ${errorMessage(error)}`);
    process.exit(1);
  }
}

main();
