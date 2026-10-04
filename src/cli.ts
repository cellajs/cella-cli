/**
 * CLI entry point for sync CLI v2.
 *
 * Parses command line arguments and routes to appropriate service.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { select } from '@inquirer/prompts';
import { Command } from 'commander';
import type { AnalyzeScope, CellaCliConfig, RuntimeConfig, SyncService } from './config/types';
import pc from './utils/colors';
import { resolveUpstream } from './utils/config';
import { NAME, printHeader, setJsonMode, VERSION } from './utils/display';
import { printWarnings, validateOverrides } from './utils/overrides';

type CliServiceSelection = {
  service?: SyncService;
  options: CliOptionState;
};

type CliOptionState = Pick<
  RuntimeConfig,
  | 'logFile'
  | 'verbose'
  | 'list'
  | 'json'
  | 'diff'
  | 'openDiff'
  | 'scope'
  | 'fork'
  | 'hard'
  | 'unpinned'
  | 'track'
  | 'ref'
  | 'keepConfig'
  | 'force'
  | 'checkOverrides'
  | 'coverage'
  | 'all'
  | 'show'
  | 'extract'
  | 'run'
  | 'script'
  | 'runArgs'
  | 'mark'
>;

type MenuContext = {
  hasForks: boolean;
  isUpstreamRepo: boolean;
};

type ServiceOptionDefinition = {
  flags: string;
  description: string;
};

type ServiceDefinition = {
  name: SyncService;
  description: string;
  options?: ServiceOptionDefinition[];
  /** Arguments the service takes after its options, e.g. the ones `migrate --run` hands to the codemod. */
  operands?: ServiceOptionDefinition;
  includeInMenu?: (context: MenuContext) => boolean;
  menuDescription?: (context: MenuContext) => string;
};

function readOptions(opts: Record<string, unknown>, operands: string[] = []): CliOptionState {
  const scope = typeof opts.scope === 'string' ? opts.scope : undefined;
  if (scope && scope !== 'all' && scope !== 'risk' && scope !== 'protected') {
    throw new Error(`invalid --scope '${scope}'. expected one of: all, risk, protected`);
  }
  const normalizedScope = scope as AnalyzeScope | undefined;

  const run = typeof opts.run === 'string' ? opts.run : undefined;
  if (operands.length > 0 && !run) {
    throw new Error(`unexpected argument '${operands[0]}'. arguments after the options only go with --run <id>`);
  }

  return {
    logFile: opts.log === true,
    verbose: opts.verbose === true,
    list: opts.list === true,
    json: opts.json === true,
    diff: typeof opts.diff === 'string' ? opts.diff : undefined,
    openDiff: typeof opts.openDiff === 'string' ? opts.openDiff : undefined,
    scope: normalizedScope,
    fork: typeof opts.fork === 'string' ? opts.fork : undefined,
    hard: opts.hard === true,
    unpinned: opts.unpinned === true,
    track: opts.track === 'release' || opts.track === 'branch' ? opts.track : undefined,
    ref: typeof opts.ref === 'string' && opts.ref ? opts.ref : undefined,
    keepConfig: opts.keepConfig === true,
    force: opts.force === true,
    checkOverrides: opts.checkOverrides === true,
    coverage: opts.coverage === true,
    all: opts.all === true,
    show: typeof opts.show === 'string' ? opts.show : undefined,
    extract: typeof opts.extract === 'string' ? opts.extract : undefined,
    run,
    script: typeof opts.script === 'string' ? opts.script : undefined,
    runArgs: run ? operands : undefined,
    mark: Array.isArray(opts.mark) ? opts.mark.filter((id): id is string => typeof id === 'string') : undefined,
  };
}

const serviceDefinitions: ServiceDefinition[] = [
  {
    name: 'analyze',
    description: 'dry run to see what would change on sync',
    options: [
      { flags: '--log', description: 'write complete file list to cella-sync.log' },
      { flags: '--list', description: 'non-interactive output for tooling (one file per line)' },
      { flags: '--json', description: 'machine-readable output for tooling/agents' },
      { flags: '--scope <scope>', description: 'analyze scope for --list/--json: all|risk|protected' },
      { flags: '--track <mode>', description: 'override upstream tracking for this run: release|branch' },
      { flags: '--ref <ref>', description: 'pin the upstream commit for this run: sha, release tag or branch' },
      { flags: '--diff <path>', description: 'print unified diff for one file, then exit' },
      { flags: '--open-diff <path>', description: 'open a browser diff for one file, then exit' },
    ],
    includeInMenu: (context) => !context.isUpstreamRepo,
  },
  {
    name: 'sync',
    description: 'merge upstream changes into your app',
    options: [
      { flags: '--log', description: 'write complete file list to cella-sync.log' },
      { flags: '--hard', description: 'overwrite drifted files with upstream version (aggressive realignment)' },
      { flags: '--unpinned', description: 'ignore pinned files (except package.json) to resurface upstream changes' },
      { flags: '--track <mode>', description: 'override upstream tracking for this run: release|branch' },
      { flags: '--ref <ref>', description: 'pin the upstream commit for this run: sha, release tag or branch' },
      { flags: '--keep-config', description: 'merge with your sync config as it stands when upstream changed its own' },
    ],
    includeInMenu: (context) => !context.isUpstreamRepo,
    menuDescription: () => 'merge upstream changes + sync package.json',
  },
  {
    name: 'migrate',
    description: 'list the upstream migration notes this app has not handled yet',
    options: [
      { flags: '--all', description: 'list every upstream note, handled or not' },
      { flags: '--json', description: 'machine-readable output for tooling/agents' },
      { flags: '--show <id>', description: "print one note's README" },
      { flags: '--extract <id>', description: "write one note's folder under node_modules/.cache to run its codemod" },
      { flags: '--run <id>', description: "run one note's codemod; files identical to upstream stay as they are" },
      { flags: '--script <file>', description: 'with --run: the script to run when the note folder holds several' },
      { flags: '--mark <ids...>', description: 'record notes as handled' },
    ],
    operands: {
      flags: '[codemodArgs...]',
      description: "with --run, after `--`: arguments for the codemod (default: inventory and the note's roots)",
    },
    includeInMenu: (context) => !context.isUpstreamRepo,
  },
  {
    name: 'audit',
    description: 'check for outdated packages & vulnerabilities',
    options: [
      { flags: '--list', description: 'skip interactive update prompts after printing audit results' },
      { flags: '--force', description: 'bypass pnpm metadata cache for fresh registry data' },
      { flags: '--check-overrides', description: 'check which pnpm.overrides are still needed' },
    ],
  },
  {
    name: 'forks',
    description: 'sync downstream to local fork repositories',
    options: [
      { flags: '--fork <name>', description: 'pre-select fork by name (skips fork selection prompt)' },
      { flags: '--log', description: 'write complete file list to cella-sync.log for each synced fork' },
      { flags: '-V, --verbose', description: 'show detailed output during operations' },
      { flags: '--hard', description: 'overwrite drifted files with upstream version (aggressive realignment)' },
      {
        flags: '--keep-config',
        description: "merge with the fork's sync config as it stands when upstream changed its own",
      },
    ],
    includeInMenu: (context) => context.hasForks,
  },
  {
    name: 'contributions',
    description: 'pull and adopt changes from forks',
    options: [
      { flags: '--fork <name>', description: 'select a specific fork directly (skips fork selection)' },
      { flags: '--list', description: 'non-interactive output (one file per line)' },
      { flags: '--json', description: 'machine-readable JSON output for tooling/agents' },
      { flags: '--diff <path>', description: 'print the unified diff for a single contributed file, then exit' },
    ],
    includeInMenu: (context) => context.hasForks,
  },
  {
    name: 'stats',
    description: 'count files by category and workspace package',
    options: [
      { flags: '-V, --verbose', description: 'show detailed output during operations' },
      { flags: '--coverage', description: 'regenerate test coverage before showing the stats summary' },
    ],
  },
];

async function getMenuContext(userConfig: CellaCliConfig, forkPath: string): Promise<MenuContext> {
  return {
    hasForks: (userConfig.forks?.length ?? 0) > 0,
    isUpstreamRepo: JSON.parse(readFileSync(join(forkPath, 'package.json'), 'utf8')).name === 'cella',
  };
}

/**
 * Build service menu choices, conditionally including optional services.
 */
function buildServiceChoices(context: MenuContext) {
  // Pad service labels to align descriptions (longest label is 'contributions').
  const label = (name: string) => name.padEnd(14);
  const baseChoices = serviceDefinitions
    .filter((service) => service.includeInMenu?.(context) ?? true)
    .map((service) => ({
      value: service.name,
      name: `${label(service.name)}${pc.dim(service.menuDescription?.(context) ?? service.description)}`,
    }));

  return [
    ...baseChoices,
    { type: 'separator' as const, separator: '─'.repeat(40) },
    { value: 'exit' as const, name: pc.red(`${label('exit')}${pc.dim('quit without doing anything')}`) },
  ];
}

function addServiceCommand(
  program: Command,
  definition: ServiceDefinition,
  setSelection: (selection: CliServiceSelection) => void,
) {
  const command = program.command(definition.name).description(definition.description);

  for (const option of definition.options ?? []) {
    command.option(option.flags, option.description);
  }
  if (definition.operands) command.argument(definition.operands.flags, definition.operands.description);

  // Commander hands declared arguments to the action before the options
  command.action((...args: unknown[]) => {
    const operands = definition.operands ? (args[0] as string[]) : [];
    const opts = (definition.operands ? args[1] : args[0]) as Record<string, unknown>;
    setSelection({
      service: definition.name,
      options: readOptions(opts, operands),
    });
  });
}

function buildProgram(setSelection: (selection: CliServiceSelection) => void): Command {
  const program = new Command(NAME)
    .name('cella')
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
        '  $ cella analyze --open-diff frontend/src/routes/index.tsx',
        '  $ cella sync --hard',
        '  $ cella sync --unpinned',
        '  $ cella sync --track branch',
        '  $ cella sync --ref 4f7d87c',
        '  $ cella migrate --run 20261001T2116-tailwind-class-conventions -- rewrite frontend/src',
        '  $ cella migrate --mark 20261002T0614-config-switch',
        '  $ cella audit --check-overrides',
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
    choices: buildServiceChoices(await getMenuContext(userConfig, forkPath)),
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
): RuntimeConfig {
  // Static fallback ref (branch tip). For release tracking the merge engine resolves
  // the concrete release-tag ref after fetching and writes it back to config.upstreamRef.
  const { branchRef } = resolveUpstream(userConfig.settings);

  return {
    ...userConfig,
    forkPath,
    upstreamRef: branchRef,
    service: selection.service ?? 'analyze',
    ...selection.options,
  };
}

/**
 * Parse CLI arguments and return configuration.
 */
export async function parseCli(userConfig: CellaCliConfig, forkPath: string): Promise<RuntimeConfig> {
  const selection = parseCommandLine(process.argv);

  // In machine-output modes (--json, --diff), reserve stdout for the payload/patch
  // and route all human output (header, warnings, spinner) to stderr.
  if (selection.options.json || selection.options.diff) setJsonMode(true);

  // Print header
  printHeader();

  // Validate config and show warnings (ignored entries are looked up at the upstream branch as last fetched)
  const warnings = await validateOverrides(userConfig, forkPath, resolveUpstream(userConfig.settings).branchRef);
  if (warnings.length > 0) {
    printWarnings(warnings);
    console.info();
  }

  // If no service provided, prompt for it
  if (!selection.service) {
    selection.service = await promptForService(userConfig, forkPath);
  }

  return buildRuntimeConfig(userConfig, forkPath, selection);
}
