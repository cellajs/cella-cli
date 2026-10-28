/**
 * Command-line parsing: the service definitions, commander wiring, and the
 * interactive service menu, resolved into a RuntimeConfig.
 */

import process from 'node:process';
import { select } from '@inquirer/prompts';
import { Command } from 'commander';
import type { AnalyzeScope, CellaCliConfig, RuntimeConfig, SyncService } from './config/types';
import pc from './utils/colors';
import { isUpstreamRepo, renamedSettingWarnings, resolveUpstream } from './utils/config';
import { MENU_DIVIDER, printHeader, setJsonMode, VERSION, warningMark } from './utils/display';
import { validateOverrides } from './utils/overrides';

type CliServiceSelection = {
  service?: SyncService;
  /** The former service name the command line used, from {@link ServiceDefinition.aliases}. */
  renamedFrom?: string;
  options: CliOptionState;
};

type CliOptionState = Omit<RuntimeConfig, keyof CellaCliConfig | 'forkPath' | 'upstreamRef' | 'service'>;

type MenuContext = {
  hasForks: boolean;
  isUpstreamRepo: boolean;
};

type ServiceOption = [flags: string, description: string];

type ServiceDefinition = {
  name: SyncService;
  description: string;
  options?: ServiceOption[];
  /** Arguments the service takes after its options, e.g. the ones `align --run` hands to the codemod. */
  operands?: ServiceOption;
  /** Former names that still run the service, hidden from help, with a warning to use the current name. */
  aliases?: string[];
  includeInMenu?: (context: MenuContext) => boolean;
};

/** A string option's value, or undefined when it was not passed. */
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A boolean flag's value: true only when it was passed. */
const flag = (value: unknown): boolean => value === true;

function readOptions(opts: Record<string, unknown>, operands: string[] = []): CliOptionState {
  const scope = str(opts.scope);
  if (scope && scope !== 'all' && scope !== 'risk' && scope !== 'protected') {
    throw new Error(`invalid --scope '${scope}'. expected one of: all, risk, protected`);
  }
  const normalizedScope = scope as AnalyzeScope | undefined;

  const run = str(opts.run);
  if (operands.length > 0 && !run) {
    throw new Error(`unexpected argument '${operands[0]}'. arguments after the options only go with --run <id>`);
  }

  return {
    verbose: flag(opts.verbose),
    list: flag(opts.list),
    json: flag(opts.json),
    scope: normalizedScope,
    fork: str(opts.fork),
    track: opts.track === 'release' || opts.track === 'branch' ? opts.track : undefined,
    ref: str(opts.ref) || undefined,
    keepConfig: flag(opts.keepConfig),
    unpinned: flag(opts.unpinned),
    since: str(opts.since) || undefined,
    md: flag(opts.md),
    all: flag(opts.all),
    show: str(opts.show),
    extract: str(opts.extract),
    run,
    runArgs: run ? operands : undefined,
    mark: Array.isArray(opts.mark) ? opts.mark.filter((id): id is string => typeof id === 'string') : undefined,
  };
}

// Option literals shared verbatim by more than one service.
const jsonOption: ServiceOption = ['--json', 'machine-readable output for tooling/agents'];
const trackOption: ServiceOption = ['--track <mode>', 'override upstream tracking for this run: release|branch'];
const refOption: ServiceOption = ['--ref <ref>', 'pin the upstream commit for this run: sha, release tag or branch'];
const unpinnedOption: ServiceOption = [
  '--unpinned',
  'lift every pinned entry for this run (managed files stay pinned) and merge from the full upstream history',
];
const forkOption: ServiceOption = ['--fork <name>', 'pre-select a fork by name (skips the fork selection prompt)'];

const serviceDefinitions: ServiceDefinition[] = [
  {
    name: 'analyze',
    description: 'dry run to see what would change on upgrade',
    options: [
      ['--list', 'non-interactive output for tooling (one file per line)'],
      jsonOption,
      ['--scope <scope>', 'analyze scope for --list/--json: all|risk|protected'],
      ['--all', 'list every file instead of collapsing large groups'],
      trackOption,
      refOption,
      unpinnedOption,
    ],
    includeInMenu: (context) => !context.isUpstreamRepo,
  },
  {
    name: 'upgrade',
    description: 'merge upstream changes onto a fresh branch, merge package.json and open a squash-merge PR',
    aliases: ['sync'],
    options: [
      trackOption,
      refOption,
      ['--keep-config', 'merge with your CLI config as it stands when upstream changed its own'],
      unpinnedOption,
    ],
    includeInMenu: (context) => !context.isUpstreamRepo,
  },
  {
    name: 'align',
    description: 'list the upstream alignments this app has not handled yet',
    options: [
      ['--all', 'list every upstream alignment, handled or not'],
      jsonOption,
      ['--show <id>', "print one alignment's README and what git tells about it"],
      ['--extract <id>', "write one alignment's folder under node_modules/.cache to run its codemod"],
      ['--run <id>', "run one alignment's codemod; files identical to upstream stay as they are"],
      ['--mark <ids...>', 'record alignments as handled'],
    ],
    operands: [
      '[codemodArgs...]',
      "with --run, after `--`: arguments for the codemod (default: inventory and the alignment's roots)",
    ],
    includeInMenu: (context) => !context.isUpstreamRepo,
  },
  {
    name: 'audit',
    description: 'update outdated packages and runtime pins, then rebuild the security overrides from a fresh audit',
    options: [['--list', 'report only: no prompts, and nothing is written']],
  },
  {
    name: 'forks',
    description: 'run the upgrade inside local fork repositories',
    options: [
      forkOption,
      ['--keep-config', "merge with the fork's CLI config as it stands when upstream changed its own"],
    ],
    includeInMenu: (context) => context.hasForks,
  },
  {
    name: 'contributions',
    description: 'pull and adopt changes from local forks',
    options: [forkOption, jsonOption],
    includeInMenu: (context) => context.hasForks,
  },
  {
    name: 'stats',
    description: 'count files by category and workspace package',
    options: [
      ['-V, --verbose', 'show detailed output during operations'],
      ['--since <ref>', 'count what the current branch changed since it left <ref>, by kind of file'],
      ['--md', 'with --since: print the table as markdown for a pull request description'],
    ],
  },
];

function getMenuContext(userConfig: CellaCliConfig, forkPath: string): MenuContext {
  return {
    hasForks: (userConfig.forks?.length ?? 0) > 0,
    isUpstreamRepo: isUpstreamRepo(forkPath),
  };
}

function buildServiceChoices(context: MenuContext) {
  // Pad service labels to align descriptions (longest label is 'contributions').
  const label = (name: string) => name.padEnd(14);
  const baseChoices = serviceDefinitions
    .filter((service) => service.includeInMenu?.(context) ?? true)
    .map((service) => ({
      value: service.name,
      name: `${label(service.name)}${pc.dim(service.description)}`,
    }));

  return [
    ...baseChoices,
    { type: 'separator' as const, separator: MENU_DIVIDER },
    { value: 'exit' as const, name: pc.red(`${label('exit')}${pc.dim('quit without doing anything')}`) },
  ];
}

function addServiceCommand(
  program: Command,
  definition: ServiceDefinition,
  setSelection: (selection: CliServiceSelection) => void,
) {
  for (const name of [definition.name, ...(definition.aliases ?? [])]) {
    const renamedFrom = name === definition.name ? undefined : name;
    const command = program.command(name, { hidden: !!renamedFrom }).description(definition.description);

    for (const option of definition.options ?? []) command.option(...option);
    if (definition.operands) command.argument(...definition.operands);

    // Commander hands declared arguments to the action before the options
    command.action((...args: unknown[]) => {
      const operands = definition.operands ? (args[0] as string[]) : [];
      const opts = (definition.operands ? args[1] : args[0]) as Record<string, unknown>;
      setSelection({
        service: definition.name,
        renamedFrom,
        options: readOptions(opts, operands),
      });
    });
  }
}

function buildProgram(setSelection: (selection: CliServiceSelection) => void): Command {
  const program = new Command('cella')
    .version(VERSION, '-v, --version', 'output the current version')
    .usage('[service] [options]')
    .helpOption('-h, --help', 'display help for a command')
    .showHelpAfterError()
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ cella analyze',
        '  $ cella analyze --json --scope risk',
        '  $ cella upgrade --track branch',
        '  $ cella upgrade --ref 4f7d87c',
        '  $ cella align --run 20261001T2116-tailwind-class-conventions -- rewrite frontend/src',
        '  $ cella align --mark 20261002T0614-config-switch',
        '  $ cella audit --list',
        '  $ cella stats --since origin/main --md',
        '  $ cella contributions --fork raak --json',
      ].join('\n'),
    );

  for (const definition of serviceDefinitions) {
    addServiceCommand(program, definition, setSelection);
  }

  return program;
}

function parseCommandLine(argv: string[]): CliServiceSelection {
  if (argv.length <= 2) {
    return { options: readOptions({}) };
  }

  let selection: CliServiceSelection = { options: readOptions({}) };
  const program = buildProgram((nextSelection) => {
    selection = nextSelection;
  });

  program.parse(argv);
  return selection;
}

async function promptForService(userConfig: CellaCliConfig, forkPath: string): Promise<SyncService> {
  const selected = await select<SyncService | 'exit'>({
    message: 'choose a service:',
    choices: buildServiceChoices(getMenuContext(userConfig, forkPath)),
    loop: false,
  });

  if (selected === 'exit') {
    console.info(pc.dim('exiting...'));
    console.info();
    process.exit(0);
  }

  console.info();
  return selected;
}

function buildRuntimeConfig(
  userConfig: CellaCliConfig,
  forkPath: string,
  selection: CliServiceSelection,
  upstreamRef: string,
): RuntimeConfig {
  return { ...userConfig, forkPath, upstreamRef, service: selection.service ?? 'analyze', ...selection.options };
}

export async function parseCli(userConfig: CellaCliConfig, forkPath: string): Promise<RuntimeConfig> {
  const selection = parseCommandLine(process.argv);

  // In machine-output modes (--json, --list, --md), reserve stdout for the payload/rows/table
  // and route all human output (header, warnings, spinner) to stderr. Audit's --list only skips
  // its interactive prompts; its report is the human output and stays on stdout.
  const machineList = selection.options.list && selection.service !== 'audit';
  if (selection.options.json || selection.options.md || machineList) setJsonMode(true);

  printHeader();

  // The upstream branch tip as last fetched: ignored entries are validated against it, and it is the
  // upstreamRef until the merge engine resolves the release tag when tracking releases.
  const { branchRef } = resolveUpstream(userConfig.settings);
  const warnings = [
    ...renamedSettingWarnings(userConfig),
    ...(await validateOverrides(userConfig, forkPath, branchRef)),
  ];
  if (selection.renamedFrom) {
    warnings.unshift(`\`cella ${selection.renamedFrom}\` is renamed to \`cella ${selection.service}\``);
  }
  for (const warning of warnings) console.info(`${warningMark} ${warning}`);
  if (warnings.length > 0) console.info();

  if (!selection.service) {
    selection.service = await promptForService(userConfig, forkPath);
  }

  return buildRuntimeConfig(userConfig, forkPath, selection, branchRef);
}
