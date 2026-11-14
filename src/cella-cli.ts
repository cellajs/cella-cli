#!/usr/bin/env tsx
/**
 * Cella CLI main entry point: resolves the repository root, runs a tool command without the
 * upgrade config, or loads the config and routes to the selected upstream service.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { runAudit } from './audit/audit';
import { parseCli, parseToolCommand, type ToolSelection } from './cli';
import { loadConfig } from './config/load';
import type { CellaCliConfig, CliService, RuntimeConfig } from './config/types';
import { runAdopt } from './upstream/adopt';
import { runAlign } from './upstream/align';
import { runAnalyze } from './upstream/analyze';
import { runUpgradeCommand } from './upstream/upgrade';
import pc from './utils/colors';
import { printHeader } from './utils/display';
import { errorMessage } from './utils/errors';
import { installSignalHandlers } from './utils/signals';

/**
 * Pre-flight check before running a service: verifies the path is a git repository.
 * The upgrade service cuts its own temporary branch from the trunk and owns its own
 * clean/resume state, so neither the current branch nor a dirty tree blocks a run.
 */
function preflight(repoRoot: string): void {
  if (!existsSync(join(repoRoot, '.git'))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
}

/** What each service runs once the command line is parsed. */
const services: Record<CliService, (config: RuntimeConfig) => Promise<unknown>> = {
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

async function runTool({ tool, options }: ToolSelection, repoRoot: string): Promise<void> {
  preflight(repoRoot);
  process.exitCode = await tool.run(repoRoot, options);
}

async function main(): Promise<void> {
  installSignalHandlers();
  try {
    const repoRoot = process.cwd();

    if (isHelpOrVersionRequest()) {
      await parseCli({ settings: { upstreamUrl: '', upstreamBranch: 'main' } } as CellaCliConfig, repoRoot);
      return;
    }

    const tool = parseToolCommand(process.argv);
    if (tool) {
      // A gate prints its verdict alone: CI logs and agents read it
      const gate = tool.tool.group === 'gate';
      if (!gate) printHeader();
      await runTool(tool, repoRoot);
      if (!gate) console.info();
      return;
    }

    const userConfig = await loadConfig(repoRoot);

    const config = await parseCli(userConfig, repoRoot);
    if ('tool' in config) {
      await runTool(config, repoRoot);
      console.info();
      return;
    }

    // Audit needs no repository: outside one, `git ls-files` finds no Dockerfile and only the image pins go unread
    if (config.service !== 'audit') preflight(repoRoot);

    await services[config.service](config);

    console.info();
  } catch (error) {
    console.error();
    console.error(`${pc.red('✗')} ${errorMessage(error)}`);
    process.exit(1);
  }
}

main();
