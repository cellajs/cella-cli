import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { CommanderError } from 'commander';
import { parseCommandLine, promptForCommand, type Selection } from './cli';
import type { MenuContext } from './command';
import { isUpstreamRepo, loadConfig } from './config/load';
import { hasInfraFolder } from './infra/command';
import { configFile } from './upstream/managed-files';
import pc from './utils/colors';
import { printHeader, printLogo, setJsonMode } from './utils/display';
import { errorMessage } from './utils/errors';
import { installSignalHandlers } from './utils/signals';

/** The menu runs in any repository: it reads the app's config only when there is one. */
async function readMenuContext(repoRoot: string): Promise<MenuContext> {
  const config = existsSync(join(repoRoot, configFile)) ? await loadConfig(repoRoot) : undefined;
  return {
    hasForks: (config?.forks?.length ?? 0) > 0,
    isUpstreamRepo: isUpstreamRepo(repoRoot),
    hasInfra: hasInfraFolder(repoRoot),
  };
}

/**
 * The CLI's main entry point: picks the command from the command line or the menu, runs it in the working directory and
 * resolves to the code it returns. A command that hands over, picked in the menu, opens the menu again when it resolves to 0.
 */
async function main(): Promise<number> {
  const repoRoot = process.cwd();
  const named = parseCommandLine(process.argv);
  if (named) return runCommand(repoRoot, named);

  // The menu opens under the logo and draws the header with its own lines, which a pick erases
  printLogo();
  const context = await readMenuContext(repoRoot);
  let start: string | undefined;
  while (true) {
    const selection = await promptForCommand(context, start);
    const code = await runCommand(repoRoot, selection);
    if (!selection.command.handsOver || code !== 0) return code;
    start = selection.command.name;
  }
}

/** Run a command the command line or the menu picked, and resolve to its exit code. */
async function runCommand(repoRoot: string, { command, options, machineOutput }: Selection): Promise<number> {
  if (machineOutput) setJsonMode(true);
  // A gate prints its verdict alone: CI logs and agents read it. A command that hands over prints all its output itself
  const quiet = command.group === 'gate' || command.handsOver === true;
  if (!quiet) printHeader();

  if (!command.outsideGit && !existsSync(join(repoRoot, '.git'))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
  const code = command.needsConfig ? await command.run(repoRoot, options, await loadConfig(repoRoot)) : await command.run(repoRoot, options);

  if (!quiet) console.info();
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
    // Inquirer rejects a question a person left with ctrl-c, and one it could not ask without a terminal, with the same error
    if (error instanceof Error && error.name === 'ExitPromptError') {
      if (process.stdin.isTTY) console.info(pc.dim('Cancelled.'));
      else console.error(`${pc.red('✗')} A question needed an answer and this run has no terminal to ask on.`);
      process.exitCode = process.stdin.isTTY ? 0 : 1;
      return;
    }
    console.error();
    console.error(`${pc.red('✗')} ${errorMessage(error)}`);
    process.exitCode = 2;
  },
);
