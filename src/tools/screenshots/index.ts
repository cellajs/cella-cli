import type { ToolCommand } from '../../config/types';
import { requireChromium } from '../drive';
import { withTestbed } from '../testbed';
import { loadShotList, requireEncoder, type ShootOptions, shoot } from './shoot';

async function runScreenshots(forkPath: string, options: ShootOptions): Promise<number> {
  // Before the testbed starts: an adapter that does not fit, an unknown id or a missing encoder fails in seconds
  const list = await loadShotList(forkPath);
  const unknown = options.ids.filter((id) => !list.shots.some((shot) => shot.id === id));
  if (unknown.length > 0) {
    throw new Error(`no shot ${unknown.join(', ')}: this app shoots ${list.shots.map((shot) => shot.id).join(', ')}`);
  }
  requireEncoder(list.format);
  await requireChromium(forkPath);
  return withTestbed(forkPath, (testbed) => shoot(forkPath, list, testbed, options));
}

export const screenshotsCommand: ToolCommand<ShootOptions> = {
  name: 'screenshots',
  group: 'develop',
  description: 'shoot the marketing screenshots on a testbed, a light and a dark file each',
  jobs: [],
  operands: ['[ids...]', 'the shots to take (default: all)'],
  options: [
    ['--out <dir>', 'write into this folder, a trial run that leaves the working tree alone'],
    ['--email <address>', 'the shot user (default ADMIN_EMAIL in backend/.env)'],
  ],
  parse: ({ operands, opts }) => ({
    ids: operands,
    out: typeof opts.out === 'string' ? opts.out : undefined,
    email: typeof opts.email === 'string' ? opts.email : undefined,
  }),
  run: runScreenshots,
};
