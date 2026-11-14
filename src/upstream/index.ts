import type { Command, CommandOption, MenuContext } from '../command';
import { resolveUpstream } from '../config/load';
import type { CellaCliConfig, EngineOptions, RuntimeConfig } from '../config/types';
import { warningMark } from '../utils/display';
import { type AdoptOptions, runAdopt } from './adopt';
import { type AlignOptions, runAlign } from './align';
import { type AnalyzeOutput, runAnalyze } from './analyze';
import { validateOverrides } from './protection';
import { runUpgradeCommand } from './upgrade';

/**
 * What the upstream code runs on: the app's config, the repository, the upstream branch tip as last fetched (the merge
 * engine resolves a release tag from it when tracking releases) and the engine's options. Prints a warning for each
 * override entry that cannot work at that tip.
 */
async function upstreamContext(
  repoRoot: string,
  config: CellaCliConfig,
  engine: EngineOptions = {},
): Promise<RuntimeConfig> {
  const { branchRef } = resolveUpstream(config);
  const warnings = await validateOverrides(config, repoRoot, branchRef);
  for (const warning of warnings) console.info(`${warningMark} ${warning}`);
  if (warnings.length > 0) console.info();
  return { ...config, repoRoot, upstreamRef: branchRef, ...engine };
}

/** A string option's value, or undefined when it was not passed or is empty. */
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** One of `allowed`, or undefined when `--<name>` was not passed. */
function choice<T extends string>(opts: Record<string, unknown>, name: string, allowed: readonly T[]): T | undefined {
  const value = opts[name];
  if (value === undefined) return undefined;
  const match = allowed.find((option) => option === value);
  if (!match) throw new Error(`invalid --${name} '${value}'. expected one of: ${allowed.join(', ')}`);
  return match;
}

const jsonOption: CommandOption = ['--json', 'machine-readable output for tooling/agents'];
const trackOption: CommandOption = ['--track <mode>', 'override upstream tracking for this run: release|branch'];
const refOption: CommandOption = ['--ref <ref>', 'pin the upstream commit for this run: sha, release tag or branch'];
const unpinnedOption: CommandOption = [
  '--unpinned',
  'lift every pinned entry for this run (managed files stay pinned) and merge from the full upstream history',
];

/** The template itself has no upstream to upgrade from. */
const notTemplate = (context: MenuContext) => !context.isUpstreamRepo;

export const analyzeCommand: Command<AnalyzeOutput & EngineOptions> = {
  name: 'analyze',
  group: 'upstream',
  description: 'dry run to see what would change on upgrade',
  needsConfig: true,
  inMenu: notTemplate,
  jobs: [],
  options: [
    ['--list', 'non-interactive output for tooling (one file per line)'],
    jsonOption,
    ['--scope <scope>', 'analyze scope for --list/--json: all|risk|protected'],
    ['--all', 'list every file instead of collapsing large groups'],
    trackOption,
    refOption,
    unpinnedOption,
  ],
  machineOutput: ['json', 'list'],
  parse: ({ opts }) => ({
    list: opts.list === true,
    json: opts.json === true,
    scope: choice(opts, 'scope', ['all', 'risk', 'protected']),
    all: opts.all === true,
    track: choice(opts, 'track', ['release', 'branch']),
    ref: text(opts.ref),
    unpinned: opts.unpinned === true,
  }),
  run: async (repoRoot, { track, ref, unpinned, ...output }, config) => {
    await runAnalyze(await upstreamContext(repoRoot, config, { track, ref, unpinned }), output);
    return 0;
  },
};

export const upgradeCommand: Command<EngineOptions> = {
  name: 'upgrade',
  group: 'upstream',
  description: 'merge upstream changes onto a fresh branch, merge package.json and open a squash-merge PR',
  needsConfig: true,
  inMenu: notTemplate,
  jobs: [],
  options: [
    trackOption,
    refOption,
    ['--keep-config', 'merge with your CLI config as it stands when upstream changed its own'],
    unpinnedOption,
  ],
  parse: ({ opts }) => ({
    track: choice(opts, 'track', ['release', 'branch']),
    ref: text(opts.ref),
    keepConfig: opts.keepConfig === true,
    unpinned: opts.unpinned === true,
  }),
  run: async (repoRoot, options, config) => runUpgradeCommand(await upstreamContext(repoRoot, config, options)),
};

export const alignCommand: Command<AlignOptions, AlignOptions['job']> = {
  name: 'align',
  group: 'upstream',
  description: 'the upstream alignments this app has not handled yet: list, read, run their codemods, record them',
  needsConfig: true,
  inMenu: notTemplate,
  jobs: [
    ['list', 'the open alignments, with summary and links'],
    ['show', "one alignment's README and what git tells about it"],
    ['run', "run one alignment's codemod; files identical to upstream stay as they are"],
    ['mark', 'record alignments as handled'],
  ],
  operands: [
    '[ids...]',
    "show and run: one alignment id; mark: the ids to record. run hands the words after `--` to the codemod (default: inventory and the alignment's roots)",
  ],
  options: [
    ['--all', 'every upstream alignment, handled or not', 'list'],
    ['--json', 'machine-readable output for tooling/agents', 'list'],
  ],
  machineOutput: ['json'],
  parse: ({ job, operands, opts, passthrough }) => {
    if (passthrough.length > 0 && job !== 'run') throw new Error('only `align run <id>` takes arguments after --');
    if (job === 'list') {
      if (operands.length > 0) throw new Error(`unexpected argument '${operands[0]}'. list takes no ids`);
      return { job, all: opts.all === true, json: opts.json === true };
    }
    if (job === 'mark') {
      if (operands.length === 0) throw new Error('mark takes the ids to record: cella align mark <ids...>');
      return { job, ids: operands };
    }
    const [id, ...extra] = operands;
    if (!id || extra.length > 0) throw new Error(`${job} takes one alignment id: cella align ${job} <id>`);
    return job === 'run' ? { job, id, codemodArgs: passthrough } : { job, id };
  },
  run: async (repoRoot, options, config) => runAlign(await upstreamContext(repoRoot, config), options),
};

export const adoptCommand: Command<AdoptOptions> = {
  name: 'adopt',
  group: 'upstream',
  description: 'pull and adopt changes from local forks',
  needsConfig: true,
  inMenu: (context) => context.hasForks,
  jobs: [],
  options: [['--fork <name>', 'pre-select a fork by name (skips the fork selection prompt)'], jsonOption],
  machineOutput: ['json'],
  parse: ({ opts }) => ({ fork: text(opts.fork), json: opts.json === true }),
  run: async (repoRoot, options, config) => runAdopt(await upstreamContext(repoRoot, config), options),
};
