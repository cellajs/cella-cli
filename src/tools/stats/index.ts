import type { ToolCommand } from '../../config/types';
import { setJsonMode } from '../../utils/display';
import { runBranchStats } from './since';
import { runStats } from './snapshot';

export interface StatsOptions {
  /** Count what the current branch changed since it left this ref; the whole repository when unset */
  since?: string;
  md: boolean;
  verbose: boolean;
}

/** Reads git only, so it runs in any repository, one without `cella.config.ts` included. */
export const statsCommand: ToolCommand<StatsOptions> = {
  name: 'stats',
  group: 'develop',
  description: 'count files by category and workspace package',
  jobs: [],
  options: [
    ['-V, --verbose', 'show detailed output during operations'],
    ['--since <ref>', 'count what the current branch changed since it left <ref>, by kind of file'],
    ['--md', 'with --since: print the table as markdown for a pull request description'],
  ],
  parse({ opts }) {
    const since = typeof opts.since === 'string' && opts.since ? opts.since : undefined;
    const md = opts.md === true;
    if (md && !since) throw new Error('--md goes with --since <ref>');
    // The header and spinner go to stderr, so stdout holds the table alone
    if (md) setJsonMode(true);
    return { since, md, verbose: opts.verbose === true };
  },
  async run(forkPath, { since, md, verbose }) {
    if (since) await runBranchStats(forkPath, since, { md, verbose });
    else await runStats(forkPath, verbose);
    return 0;
  },
};
