#!/usr/bin/env tsx
/**
 * Cella CLI main entry point: picks the command from the command line or the menu, runs it in the working directory and
 * exits with the code it returns.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { CommanderError } from 'commander';
import { parseCommandLine, promptForCommand } from './cli';
import type { MenuContext } from './command';
import { isUpstreamRepo, loadConfig } from './config/load';
import { configFile } from './upstream/managed-files';
import pc from './utils/colors';
import { printHeader, printLogo, setJsonMode } from './utils/display';
import { errorMessage } from './utils/errors';
import { installSignalHandlers } from './utils/signals';

/** The menu runs in any repository: it reads the app's config only when there is one. */
async function readMenuContext(repoRoot: string): Promise<MenuContext> {
  const config = existsSync(join(repoRoot, configFile)) ? await loadConfig(repoRoot) : undefined;
  return { hasForks: (config?.forks?.length ?? 0) > 0, isUpstreamRepo: isUpstreamRepo(repoRoot) };
}

async function main(): Promise<number> {
  const repoRoot = process.cwd();
  const named = parseCommandLine(process.argv);
  // The menu opens under the logo and the header; a command named on the command line prints the header alone
  if (!named) {
    printLogo();
    printHeader();
  }
  const { command, options, machineOutput } = named ?? (await promptForCommand(await readMenuContext(repoRoot)));

  if (machineOutput) setJsonMode(true);
  // A gate prints its verdict alone: CI logs and agents read it
  const gate = command.group === 'gate';
  if (named && !gate) printHeader();

  if (!command.outsideGit && !existsSync(join(repoRoot, '.git'))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
  const code = command.needsConfig
    ? await command.run(repoRoot, options, await loadConfig(repoRoot))
    : await command.run(repoRoot, options);

  if (!gate) console.info();
  return code;
}

installSignalHandlers();
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Commander printed its own message: help and the version exit 0, a usage error 2
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? 0 : 2;
      return;
    }
    console.error();
    console.error(`${pc.red('✗')} ${errorMessage(error)}`);
    process.exitCode = 2;
  },
);
