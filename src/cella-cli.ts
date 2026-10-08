#!/usr/bin/env tsx
/**
 * Cella CLI main entry point: resolves the fork path, loads the config,
 * parses the command line and routes to the selected service.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseCli } from './cli';
import type { CellaCliConfig } from './config/types';
import { runAnalyze } from './services/analyze';
import { runAudit } from './services/audit';
import { runContributions } from './services/contributions';
import { runForks } from './services/forks';
import { runMigrate } from './services/migrate';
import { runStats } from './services/stats';
import { runBranchStats } from './services/stats-since';
import { runSyncCommand } from './services/sync';
import { registerSignalHandlers } from './utils/cleanup';
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

function isHelpOrVersionRequest(): boolean {
  return (
    process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') ||
    process.argv[2] === 'help'
  );
}

async function main(): Promise<void> {
  registerSignalHandlers();

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

    switch (config.service) {
      case 'analyze': {
        await runAnalyze(config);
        break;
      }

      case 'sync': {
        await runSyncCommand(config);
        break;
      }

      case 'migrate': {
        await runMigrate(config);
        break;
      }

      case 'audit': {
        await runAudit(config);
        break;
      }

      case 'forks': {
        await runForks(config);
        break;
      }

      case 'contributions': {
        await runContributions(config);
        break;
      }

      case 'stats': {
        if (config.md && !config.since) throw new Error('--md goes with --since <ref>');
        if (config.since) {
          await runBranchStats(config.forkPath, { since: config.since, markdown: config.md, verbose: config.verbose });
        } else {
          await runStats(config);
        }
        break;
      }
    }

    console.info();
  } catch (error) {
    console.error();
    console.error(`${pc.red('✗')} ${errorMessage(error)}`);
    process.exit(1);
  }
}

main();
