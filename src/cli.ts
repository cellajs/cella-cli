/**
 * Command-line parsing: commander wiring for every command, and the interactive menu.
 */

import process from 'node:process';
import { select } from '@inquirer/prompts';
import { Command as CommanderCommand, Option } from 'commander';
import type { Command, CommandGroup, MenuContext } from './command';
import { commands } from './commands';
import pc from './utils/colors';
import { menuDivider, version } from './utils/display';

/** A command with the options it parsed; `machineOutput` when one of them keeps stdout for the payload. */
export interface Selection {
  command: Command;
  options: unknown;
  machineOutput: boolean;
}

const groupHeadings: Record<CommandGroup, string> = {
  develop: 'Develop commands:',
  security: 'Security commands:',
  upstream: 'Upstream commands:',
  gate: 'Gate commands:',
};

/** The words of `argv` after the `--` that follows the command name. */
function wordsAfterDash(argv: string[], commandName: string): string[] {
  const dash = argv.indexOf('--', argv.indexOf(commandName));
  return dash === -1 ? [] : argv.slice(dash + 1);
}

function addCommand(
  program: CommanderCommand,
  declared: Command,
  argv: string[],
  pick: (selection: Selection) => void,
) {
  const jobs = declared.jobs.map(([name]) => name);
  const command = program
    .command(declared.name)
    .description(declared.description)
    .helpGroup(groupHeadings[declared.group]);
  const jobLines = declared.jobs.map(
    ([name, description], i) => `${name}${i === 0 ? ' (default)' : ''}: ${description}`,
  );
  if (jobs.length > 0) command.argument('[job]', jobLines.join('\n'));
  // Commander takes one variadic argument, the last: the command's own words, else the words after `--`
  if (declared.operands) command.argument(...declared.operands);
  else if (declared.passthrough) command.argument(`[${declared.passthrough[0]}...]`, declared.passthrough[1]);
  const jobOptions: [Option, string][] = [];
  for (const [flags, description, job] of declared.options ?? []) {
    const option = new Option(flags, job ? `${job}: ${description}` : description);
    command.addOption(option);
    if (job) jobOptions.push([option, job]);
  }

  command.action((...args: unknown[]) => {
    const words = args
      .slice(0, command.registeredArguments.length)
      .flat()
      .filter((word) => typeof word === 'string');
    const opts: Record<string, unknown> = command.opts();
    // Commander puts the words after `--` among the operands; the job and operands are what comes before them
    const passthrough = wordsAfterDash(argv, declared.name);
    const before = words.slice(0, words.length - passthrough.length);
    const operands = jobs.length > 0 ? before.slice(1) : before;
    if (!declared.operands && operands.length > 0) {
      const hint = declared.passthrough ? '. a command to run goes after --' : '';
      throw new Error(`unexpected argument '${operands[0]}'${hint}`);
    }
    const job = jobs.length > 0 ? (before[0] ?? jobs[0]) : undefined;
    if (job !== undefined && !jobs.includes(job)) {
      throw new Error(`unknown job '${job}'. expected one of: ${jobs.join(', ')}`);
    }
    for (const [option, owner] of jobOptions) {
      if (opts[option.attributeName()] !== undefined && owner !== job) {
        throw new Error(`${option.long} goes with \`${declared.name} ${owner}\``);
      }
    }
    pick({
      command: declared,
      options: declared.parse({ job, operands, opts, passthrough }),
      machineOutput: declared.machineOutput?.some((name) => opts[name] === true) ?? false,
    });
  });
}

/**
 * The command `argv` names, parsed. Undefined for a bare `cella` in a terminal, which opens the menu; without a
 * terminal it prints the help. Commander throws a `CommanderError` for help, the version and a usage error.
 */
export function parseCommandLine(argv: string[]): Selection | undefined {
  const bare = argv.length <= 2;
  if (bare && process.stdin.isTTY && process.stdout.isTTY) return undefined;

  const program = new CommanderCommand('cella')
    .exitOverride()
    .version(version, '-v, --version', 'output the current version')
    .usage('[command] [options]')
    .helpOption('-h, --help', 'display help for a command')
    .showHelpAfterError()
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ cella testbed',
        '  $ cella testbed -- node cella/skills/verify/smoke-driver.mjs',
        '  $ cella bench get-me --short --isolated',
        '  $ cella a11y --states sign-in,home',
        '  $ cella a11y decide --file decisions.json',
        '  $ cella shoot settings',
        '  $ cella i18n unused --json',
        '  $ cella i18n rename c:old_key c:new_key',
        '  $ cella analyze',
        '  $ cella analyze --json --scope risk',
        '  $ cella upgrade --track branch',
        '  $ cella upgrade --ref 4f7d87c',
        '  $ cella align run 20261001T2116-tailwind-class-conventions -- rewrite frontend/src',
        '  $ cella align mark 20261002T0614-config-switch',
        '  $ cella audit',
        '  $ cella stats --since origin/main --md',
        '  $ cella adopt --fork raak --json',
        '  $ cella style frontend/src',
      ].join('\n'),
    );

  let selection: Selection | undefined;
  for (const command of commands) {
    addCommand(program, command, argv, (picked) => {
      selection = picked;
    });
  }
  if (bare) program.help();
  program.parse(argv);
  return selection;
}

/** The command picked from the menu, with a job when it has several the menu can run. */
export async function promptForCommand(context: MenuContext): Promise<Selection> {
  const entries = commands.filter((command) => command.group !== 'gate' && (command.inMenu?.(context) ?? true));
  const width = Math.max(...entries.map((entry) => entry.name.length)) + 3;
  const label = (name: string) => name.padEnd(width);

  const picked = await select<string>({
    message: 'choose a command:',
    choices: [
      ...entries.map((entry) => ({ value: entry.name, name: `${label(entry.name)}${pc.dim(entry.description)}` })),
      { type: 'separator' as const, separator: menuDivider },
      { value: 'exit', name: pc.red(`${label('exit')}${pc.dim('quit without doing anything')}`) },
    ],
    // The page grows with the terminal, less the three rows of the question and key hints; seven is Inquirer's default
    pageSize: Math.max(7, (process.stdout.rows || 24) - 3),
    loop: false,
  });

  const command = entries.find((entry) => entry.name === picked);
  if (!command) {
    console.info(pc.dim('exiting...'));
    console.info();
    process.exit(0);
  }

  const parse = (job: string | undefined) => command.parse({ job, operands: [], opts: {}, passthrough: [] });
  // The menu passes no words: a job that needs them, such as `align show <id>`, runs from the command line only
  const runnable = command.jobs.filter(([job]) => {
    try {
      parse(job);
      return true;
    } catch {
      return false;
    }
  });
  const job =
    runnable.length > 1
      ? await select<string>({
          message: `${command.name}:`,
          choices: runnable.map(([name, description]) => ({
            value: name,
            name: `${name.padEnd(14)}${pc.dim(description)}`,
          })),
          loop: false,
        })
      : runnable[0]?.[0];
  console.info();
  return { command, options: parse(job), machineOutput: false };
}
