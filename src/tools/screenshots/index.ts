import type { ToolCommand } from '../../config/types';
import { requireChromium } from '../drive';
import { hasShowcase, withTestbed } from '../testbed';
import { loadShotList, requireEncoder, type ShootOptions, shoot } from './shoot';

async function runShoot(forkPath: string, options: ShootOptions): Promise<number> {
  // Before the testbed starts: an adapter that does not fit, an unknown id or a missing encoder fails in seconds
  const list = await loadShotList(forkPath);
  const unknown = options.ids.filter((id) => !list.shots.some((shot) => shot.id === id));
  if (unknown.length > 0) {
    throw new Error(`no shot ${unknown.join(', ')}: this app shoots ${list.shots.map((shot) => shot.id).join(', ')}`);
  }
  requireEncoder(list);
  await requireChromium(forkPath);
  // An app with a showcase shoots its curated data, on a database no other tool writes to
  const data = hasShowcase(forkPath) ? 'showcase' : 'seed';
  return withTestbed(forkPath, (testbed) => shoot(forkPath, list, testbed, options), { data });
}

export const shootCommand: ToolCommand<ShootOptions> = {
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
