/**
 * Command-line parsing: the command definitions, commander wiring, and the
 * interactive menu, resolved into a RuntimeConfig or a tool command to run.
 */

import process from 'node:process';
import { select } from '@inquirer/prompts';
import { Command } from 'commander';
import type {
  AnalyzeScope,
  CellaCliConfig,
  CommandGroup,
  CommandOption,
  RuntimeConfig,
  SyncService,
  ToolCommand,
} from './config/types';
import { toolCommands } from './tools';
import pc from './utils/colors';
import { isUpstreamRepo, renamedSettingWarnings, resolveUpstream } from './utils/config';
import { MENU_DIVIDER, printHeader, setJsonMode, VERSION, warningMark } from './utils/display';
import { validateOverrides } from './utils/overrides';

/** A tool command and the options it parsed for itself. */
export type ToolSelection = { tool: ToolCommand; options: unknown };

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

type ServiceDefinition = {
  name: SyncService;
  /** Upstream unless set. */
  group?: CommandGroup;
  description: string;
  options?: CommandOption[];
  /** Arguments the service takes after its options, e.g. the ones `align --run` hands to the codemod. */
  operands?: CommandOption;
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
const jsonOption: CommandOption = ['--json', 'machine-readable output for tooling/agents'];
const trackOption: CommandOption = ['--track <mode>', 'override upstream tracking for this run: release|branch'];
const refOption: CommandOption = ['--ref <ref>', 'pin the upstream commit for this run: sha, release tag or branch'];
const unpinnedOption: CommandOption = [
  '--unpinned',
  'lift every pinned entry for this run (managed files stay pinned) and merge from the full upstream history',
];

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
    group: 'security',
    description: 'update outdated packages and runtime pins, then rebuild the security overrides from a fresh audit',
    options: [['--list', 'report only: no prompts, and nothing is written']],
  },
  {
    name: 'adopt',
    description: 'pull and adopt changes from local forks',
    options: [['--fork <name>', 'pre-select a fork by name (skips the fork selection prompt)'], jsonOption],
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

const groupOrder: CommandGroup[] = ['develop', 'security', 'upstream', 'gate'];

const groupHeadings: Record<CommandGroup, string> = {
  develop: 'Develop commands:',
  security: 'Security commands:',
  upstream: 'Upstream commands:',
  gate: 'Gate commands:',
};

const serviceGroup = (definition: ServiceDefinition): CommandGroup => definition.group ?? 'upstream';

function buildMenuChoices(context: MenuContext) {
  const entries: { name: string; group: CommandGroup; description: string }[] = [
    ...serviceDefinitions
      .filter((service) => service.includeInMenu?.(context) ?? true)
      .map((service) => ({ name: service.name, group: serviceGroup(service), description: service.description })),
    ...toolCommands.filter((tool) => tool.group !== 'gate' && !tool.notInMenu),
  ];
  const width = Math.max(...entries.map((entry) => entry.name.length)) + 3;
  const label = (name: string) => name.padEnd(width);

  return [
    ...groupOrder
      .flatMap((group) => entries.filter((entry) => entry.group === group))
      .map((entry) => ({ value: entry.name, name: `${label(entry.name)}${pc.dim(entry.description)}` })),
    { type: 'separator' as const, separator: MENU_DIVIDER },
    { value: 'exit', name: pc.red(`${label('exit')}${pc.dim('quit without doing anything')}`) },
  ];
}

function addServiceCommand(
  program: Command,
  definition: ServiceDefinition,
  setSelection: (selection: CliServiceSelection) => void,
) {
  for (const name of [definition.name, ...(definition.aliases ?? [])]) {
    const renamedFrom = name === definition.name ? undefined : name;
    const command = program
      .command(name, { hidden: !!renamedFrom })
      .description(definition.description)
      .helpGroup(groupHeadings[serviceGroup(definition)]);

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

/** The words of `argv` after the `--` that follows the command name. */
function wordsAfterDash(argv: string[], commandName: string): string[] {
  const dash = argv.indexOf('--', argv.indexOf(commandName));
  return dash === -1 ? [] : argv.slice(dash + 1);
}

function addToolCommand(
  program: Command,
  tool: ToolCommand,
  argv: string[],
  setSelection: (selection: ToolSelection) => void,
) {
  const jobs = tool.jobs.map(([name]) => name);
  const command = program.command(tool.name).description(tool.description).helpGroup(groupHeadings[tool.group]);
  if (jobs.length > 0) command.argument('[job]', `${jobs.join('|')} (default: ${jobs[0]})`);
  // Commander takes one variadic argument, the last: the command's own words, else the words after `--`
  if (tool.operands) command.argument(...tool.operands);
  else if (tool.passthrough) command.argument(`[${tool.passthrough[0]}...]`, tool.passthrough[1]);
  for (const option of tool.options ?? []) command.option(...option);

  command.action((...args: unknown[]) => {
    const declared = command.registeredArguments.length;
    const words = args
      .slice(0, declared)
      .flat()
      .filter((word) => typeof word === 'string');
    const opts = args[declared] as Record<string, unknown>;
    // Commander puts the words after `--` among the operands; the job and operands are what comes before them
    const passthrough = wordsAfterDash(argv, tool.name);
    const before = words.slice(0, words.length - passthrough.length);
    const job = jobs.length > 0 ? before[0] : undefined;
    const operands = jobs.length > 0 ? before.slice(1) : before;
    if (!tool.operands && operands.length > 0) {
      const hint = tool.passthrough ? '. a command to run goes after --' : '';
      throw new Error(`unexpected argument '${operands[0]}'${hint}`);
    }
    setSelection({ tool, options: tool.parse({ job, operands, opts, passthrough }) });
  });
}

function buildProgram(
  argv: string[],
  setSelection: (selection: CliServiceSelection) => void,
  setToolSelection: (selection: ToolSelection) => void,
): Command {
  const program = new Command('cella')
    .version(VERSION, '-v, --version', 'output the current version')
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
        '  $ cella align --run 20261001T2116-tailwind-class-conventions -- rewrite frontend/src',
        '  $ cella align --mark 20261002T0614-config-switch',
        '  $ cella audit --list',
        '  $ cella stats --since origin/main --md',
        '  $ cella adopt --fork raak --json',
        '  $ cella style frontend/src',
      ].join('\n'),
    );

  // Commander lists the help groups in the order their first command was added
  for (const group of groupOrder) {
    for (const definition of serviceDefinitions.filter((service) => serviceGroup(service) === group)) {
      addServiceCommand(program, definition, setSelection);
    }
    for (const tool of toolCommands.filter((command) => command.group === group)) {
      addToolCommand(program, tool, argv, setToolSelection);
    }
  }

  return program;
}

function parseCommandLine(argv: string[]): CliServiceSelection {
  if (argv.length <= 2) {
    return { options: readOptions({}) };
  }

  let selection: CliServiceSelection = { options: readOptions({}) };
  const program = buildProgram(
    argv,
    (nextSelection) => {
      selection = nextSelection;
    },
    () => {},
  );

  program.parse(argv);
  return selection;
}

/** The tool command `argv` names, parsed; undefined when it names none. Tool commands load no upgrade config. */
export function parseToolCommand(argv: string[]): ToolSelection | undefined {
  if (!toolCommands.some((tool) => tool.name === argv[2])) return undefined;

  let selection: ToolSelection | undefined;
  const program = buildProgram(
    argv,
    () => {},
    (nextSelection) => {
      selection = nextSelection;
    },
  );
  program.parse(argv);
  return selection;
}

async function promptForCommand(userConfig: CellaCliConfig, forkPath: string): Promise<SyncService | ToolSelection> {
  const selected = await select<string>({
    message: 'choose a command:',
    choices: buildMenuChoices(getMenuContext(userConfig, forkPath)),
    // The page grows with the terminal, less the three rows of the question and key hints; seven is Inquirer's default
    pageSize: Math.max(7, (process.stdout.rows || 24) - 3),
    loop: false,
  });

  if (selected === 'exit') {
    console.info(pc.dim('exiting...'));
    console.info();
    process.exit(0);
  }

  const tool = toolCommands.find((command) => command.name === selected);
  if (tool) {
    const job =
      tool.jobs.length > 1
        ? await select<string>({
            message: `${tool.name}:`,
            choices: tool.jobs.map(([name, description]) => ({
              value: name,
              name: `${name.padEnd(14)}${pc.dim(description)}`,
            })),
            loop: false,
          })
        : undefined;
    console.info();
    return { tool, options: tool.parse({ job, operands: [], opts: {}, passthrough: [] }) };
  }

  console.info();
  const service = serviceDefinitions.find((definition) => definition.name === selected);
  if (!service) throw new Error(`unknown command '${selected}'`);
  return service.name;
}

function buildRuntimeConfig(
  userConfig: CellaCliConfig,
  forkPath: string,
  selection: CliServiceSelection,
  upstreamRef: string,
): RuntimeConfig {
  return { ...userConfig, forkPath, upstreamRef, service: selection.service ?? 'analyze', ...selection.options };
}

/** The upstream command to run with its config, or the tool command picked from the menu. */
export async function parseCli(userConfig: CellaCliConfig, forkPath: string): Promise<RuntimeConfig | ToolSelection> {
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
    const picked = await promptForCommand(userConfig, forkPath);
    if (typeof picked !== 'string') return picked;
    selection.service = picked;
  }

  return buildRuntimeConfig(userConfig, forkPath, selection, branchRef);
}
