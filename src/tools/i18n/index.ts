import process from 'node:process';
import { input } from '@inquirer/prompts';
import type { ToolCommand } from '../../config/types';
import { setJsonMode } from '../../utils/display';
import { type RenameOptions, runRename } from './rename';
import { runStatus } from './status';
import { runUnused } from './unused';

export type I18nOptions = Partial<RenameOptions> & { job: 'status' | 'unused' | 'rename'; json: boolean };

const jobs = ['status', 'unused', 'rename'] as const;
const isJob = (job: string): job is (typeof jobs)[number] => (jobs as readonly string[]).includes(job);

/** The two keys of a rename, asked for when the menu started it. */
async function renameKeys(options: Partial<RenameOptions>): Promise<RenameOptions> {
  if (options.from && options.to) return { from: options.from, to: options.to };
  if (!process.stdin.isTTY) throw new Error('rename takes two keys: cella i18n rename <ns:old> <ns:new>');
  const from = options.from ?? (await input({ message: 'key to rename (ns:key):' }));
  const to = options.to ?? (await input({ message: `new name for ${from}:` }));
  return { from: from.trim(), to: to.trim() };
}

export const i18nCommand: ToolCommand<I18nOptions> = {
  name: 'i18n',
  group: 'develop',
  description: 'translation status, unused keys and renames across the locale files and the code',
  jobs: [
    ['status', 'per namespace and language: missing, orphaned and mismatched translations'],
    ['unused', 'keys no code names, here and in the local forks of the config'],
    ['rename', 'rename a key in every locale file and in the code: rename <ns:old> <ns:new>'],
  ],
  options: [['--json', 'machine-readable output for tooling/agents']],
  operands: ['[keys...]', 'with rename: the key and its new name, as ns:key'],
  parse: ({ job = 'status', operands, opts }) => {
    if (!isJob(job)) throw new Error(`unknown job '${job}'. expected one of: ${jobs.join(', ')}`);
    const json = opts.json === true;
    // Before the header prints, so stdout holds the payload alone
    if (json) setJsonMode(true);
    if (job !== 'rename') {
      if (operands.length > 0) throw new Error(`unexpected argument '${operands[0]}'. only rename takes keys`);
      return { job, json };
    }
    if (operands.length > 2) throw new Error(`unexpected argument '${operands[2]}'. rename takes <ns:old> <ns:new>`);
    const [from, to] = operands;
    return { job, json, from, to };
  },
  run: async (forkPath, options) => {
    if (options.job === 'status') return runStatus(forkPath, options.json);
    if (options.job === 'unused') return runUnused(forkPath, options.json);
    return runRename(forkPath, await renameKeys(options), options.json);
  },
};
