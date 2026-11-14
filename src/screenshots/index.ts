import type { Command } from '../command';
import { hasShowcase, withTestbed } from '../testbed';
import { selectEntries } from '../utils/app-adapter';
import { requireChromium } from '../utils/browser';
import { loadShotList, requireEncoder, type ShootOptions, shoot } from './shoot';

async function runShoot(repoRoot: string, options: ShootOptions): Promise<number> {
  // Before the testbed starts: an adapter that does not fit, an unknown id or a missing encoder fails in seconds
  const all = await loadShotList(repoRoot);
  const list = { ...all, shots: selectEntries(all.shots, options.ids, 'shot') };
  requireEncoder(list);
  await requireChromium(repoRoot);
  // An app with a showcase shoots its curated data, on a database no other tool writes to
  const data = hasShowcase(repoRoot) ? 'showcase' : 'seed';
  return withTestbed(repoRoot, (testbed) => shoot(repoRoot, list, testbed, options), { data });
}

export const shootCommand: Command<ShootOptions> = {
  name: 'shoot',
  group: 'develop',
  description: 'shoot the marketing screenshots on a testbed',
  jobs: [],
  operands: ['[ids...]', 'the shots to take (default: all)'],
  options: [
    ['--out <dir>', 'write into this folder, a trial run that leaves the working tree alone'],
    ['--email <address>', 'the shot user (default the showcase admin, else ADMIN_EMAIL in .env)'],
  ],
  parse: ({ operands, opts }) => ({
    ids: operands,
    out: typeof opts.out === 'string' ? opts.out : undefined,
    email: typeof opts.email === 'string' ? opts.email : undefined,
  }),
  run: runShoot,
};
