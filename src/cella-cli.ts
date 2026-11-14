#!/usr/bin/env tsx
/**
 * Cella CLI main entry point: resolves the fork path, runs a tool command without the
 * upgrade config, or loads the config and routes to the selected upstream service.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseCli, parseToolCommand, type ToolSelection } from './cli';
import type { CellaCliConfig, RuntimeConfig, SyncService } from './config/types';
import { runAdopt } from './services/adopt';
import { runAlign } from './services/align';
import { runAnalyze } from './services/analyze';
import { runAudit } from './services/audit';
import { runUpgradeCommand } from './services/upgrade';
import pc from './utils/colors';
import { loadConfig } from './utils/config';
import { printHeader } from './utils/display';
import { getEnv } from './utils/env';
import { errorMessage } from './utils/errors';
import { installSignalHandlers } from './utils/signals';

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
 * The upgrade service cuts its own temporary branch from the trunk and owns its own
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
  upgrade: runUpgradeCommand,
  align: runAlign,
  audit: runAudit,
  adopt: runAdopt,
};

/** A help or version flag before `--`: the words after it belong to the command a tool runs. */
function isHelpOrVersionRequest(): boolean {
  const args = process.argv.slice(2);
  const end = args.indexOf('--');
  const own = end === -1 ? args : args.slice(0, end);
  return (
    own.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') || own[0] === 'help'
  );
}

async function runTool({ tool, options }: ToolSelection, forkPath: string): Promise<void> {
  preflight(forkPath);
  process.exitCode = await tool.run(forkPath, options);
}

async function main(): Promise<void> {
  installSignalHandlers();
  try {
    const forkPath = getForkPath();

    if (isHelpOrVersionRequest()) {
      await parseCli({ settings: { upstreamUrl: '', upstreamBranch: 'main' } } as CellaCliConfig, forkPath);
      return;
    }

    const tool = parseToolCommand(process.argv);
    if (tool) {
      // A gate prints its verdict alone: CI logs and agents read it
      const gate = tool.tool.group === 'gate';
      if (!gate) printHeader();
      await runTool(tool, forkPath);
      if (!gate) console.info();
      return;
    }

    const userConfig = await loadConfig(forkPath);

    const config = await parseCli(userConfig, forkPath);
    if ('tool' in config) {
      await runTool(config, forkPath);
      console.info();
      return;
    }

    // Audit needs no repository: outside one, `git ls-files` finds no Dockerfile and only the image pins go unread
    if (config.service !== 'audit') preflight(forkPath);

    await services[config.service](config);

    console.info();
  } catch (error) {
    console.error();
    console.error(`${pc.red('✗')} ${errorMessage(error)}`);
    process.exit(1);
  }
}

main();
