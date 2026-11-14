import process from 'node:process';
import { input } from '@inquirer/prompts';
import type { Command } from '../command';
import { type RenameOptions, runRename } from './rename';
import { runStatus } from './status';
import { runUnused } from './unused';

type I18nOptions = Partial<RenameOptions> & { job: 'status' | 'unused' | 'rename'; json: boolean };

/** The two keys of a rename, asked for when the menu started it. */
async function renameKeys(options: Partial<RenameOptions>): Promise<RenameOptions> {
  if (options.from && options.to) return { from: options.from, to: options.to };
  if (!process.stdin.isTTY) throw new Error('rename takes two keys: cella i18n rename <ns:old> <ns:new>');
  const from = options.from ?? (await input({ message: 'key to rename (ns:key):' }));
  const to = options.to ?? (await input({ message: `new name for ${from}:` }));
  return { from: from.trim(), to: to.trim() };
}

export const i18nCommand: Command<I18nOptions, I18nOptions['job']> = {
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
  machineOutput: ['json'],
  parse: ({ job, operands, opts }) => {
    const json = opts.json === true;
    if (job !== 'rename') {
      if (operands.length > 0) throw new Error(`unexpected argument '${operands[0]}'. only rename takes keys`);
      return { job, json };
    }
    if (operands.length > 2) throw new Error(`unexpected argument '${operands[2]}'. rename takes <ns:old> <ns:new>`);
    const [from, to] = operands;
    return { job, json, from, to };
  },
  run: async (repoRoot, options) => {
    if (options.job === 'status') return runStatus(repoRoot, options.json);
    if (options.job === 'unused') return runUnused(repoRoot, options.json);
    return runRename(repoRoot, await renameKeys(options), options.json);
  },
};
