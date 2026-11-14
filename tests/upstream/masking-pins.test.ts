/**
 * Unit tests for masking-pin detection.
 *
 * A pin whose app content is byte-identical to the previous upstream (`behind`) silently
 * freezes the file at the old version and drops upstream's changes: no conflict, no type
 * error. `findMaskingPins` isolates exactly those so the upgrade/analyze output can flag them.
 */
import { describe, expect, it } from 'vitest';
import { findMaskingPins } from '../../src/upstream/report';
import { analyzedFile as file } from '../helpers/test-env';

describe('findMaskingPins', () => {
  it('flags a pinned file that is behind upstream (app == old upstream)', () => {
    const masking = file({ path: 'frontend/src/nav-config.tsx', status: 'behind', isPinned: true });
    expect(findMaskingPins([masking])).toEqual([masking]);
  });

  it('ignores a legitimately diverged pin (app genuinely changed)', () => {
    const diverged = file({ path: 'a.ts', status: 'pinned', isPinned: true });
    expect(findMaskingPins([diverged])).toEqual([]);
  });

  it('ignores behind files that are not pinned (upstream is taken normally)', () => {
    const behind = file({ path: 'b.ts', status: 'behind', isPinned: false });
    expect(findMaskingPins([behind])).toEqual([]);
  });

  it('ignores a pinned file the app deleted or upstream removed', () => {
    const appDeleted = file({ path: 'c.ts', status: 'behind', isPinned: true, existsInApp: false });
    const upstreamGone = file({ path: 'd.ts', status: 'behind', isPinned: true, existsInUpstream: false });
    expect(findMaskingPins([appDeleted, upstreamGone])).toEqual([]);
  });

  it('leaves managed files out: the package merge reconciles them, so the pin masks nothing', () => {
    const files = [
      file({ path: 'package.json', status: 'behind', isPinned: true }),
      file({ path: 'cdc/package.json', status: 'behind', isPinned: true }),
      file({ path: 'pnpm-lock.yaml', status: 'behind', isPinned: true }),
      file({ path: 'cella/cella.config.ts', status: 'behind', isPinned: true }),
    ];
    expect(findMaskingPins(files)).toEqual([]);
  });

  it('returns only the masking pins from a mixed set', () => {
    const files = [
      file({ path: 'keep.ts', status: 'behind', isPinned: true }),
      file({ path: 'diverged.ts', status: 'pinned', isPinned: true }),
      file({ path: 'plain.ts', status: 'behind' }),
      file({ path: 'identical.ts', status: 'identical', isPinned: true }),
    ];
    expect(findMaskingPins(files).map((f) => f.path)).toEqual(['keep.ts']);
  });
});
