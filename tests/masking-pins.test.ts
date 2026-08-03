/**
 * Unit tests for masking-pin detection.
 *
 * A pin whose fork content is byte-identical to the previous upstream (`behind`) silently
 * freezes the file at the old version and drops upstream's changes — no conflict, no type
 * error. `findMaskingPins` isolates exactly those so the sync/analyze output can flag them.
 */
import { describe, expect, it } from 'vitest';
import type { AnalyzedFile, FileStatus } from '../src/config/types';
import { findMaskingPins } from '../src/utils/display';

function file(overrides: Partial<AnalyzedFile> & { path: string; status: FileStatus }): AnalyzedFile {
  return {
    isIgnored: false,
    isPinned: false,
    existsInFork: true,
    existsInUpstream: true,
    ...overrides,
  };
}

describe('findMaskingPins', () => {
  it('flags a pinned file that is behind upstream (fork == old upstream)', () => {
    const masking = file({ path: 'frontend/src/nav-config.tsx', status: 'behind', isPinned: true });
    expect(findMaskingPins([masking])).toEqual([masking]);
  });

  it('ignores a legitimately diverged pin (fork genuinely changed)', () => {
    const diverged = file({ path: 'a.ts', status: 'pinned', isPinned: true });
    expect(findMaskingPins([diverged])).toEqual([]);
  });

  it('ignores behind files that are not pinned (upstream is taken normally)', () => {
    const behind = file({ path: 'b.ts', status: 'behind', isPinned: false });
    expect(findMaskingPins([behind])).toEqual([]);
  });

  it('ignores a pinned file the fork deleted or upstream removed', () => {
    const forkDeleted = file({ path: 'c.ts', status: 'behind', isPinned: true, existsInFork: false });
    const upstreamGone = file({ path: 'd.ts', status: 'behind', isPinned: true, existsInUpstream: false });
    expect(findMaskingPins([forkDeleted, upstreamGone])).toEqual([]);
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
