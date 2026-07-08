/**
 * Unit tests for the pure helpers in the `gh` wrapper module.
 *
 * The `gh`-invoking functions hit the network and are exercised manually / in integration; here
 * we cover the pure logic that decides *which* PRs count as sync PRs and *what* argv is sent to
 * `gh pr merge`.
 */
import { describe, expect, it } from 'vitest';
import { buildMergeArgs, filterSyncPrs, type GhPullRequest } from '../src/utils/gh';

const pr = (number: number, headRefName: string): GhPullRequest => ({
  number,
  headRefName,
  title: `chore: sync upstream cella #${number}`,
  url: `https://github.com/org/app/pull/${number}`,
});

describe('filterSyncPrs', () => {
  it('keeps only PRs whose head branch is under the sync prefix', () => {
    const prs = [
      pr(1, 'cella/sync/20260101-1200'),
      pr(2, 'feature/login'),
      pr(3, 'cella/sync/20260202-0900'),
      pr(4, 'cella-sync-lookalike'), // no trailing slash — must NOT match
      pr(5, 'cella/sync'), // the bare namespace — must NOT match (needs the trailing slash)
    ];

    const result = filterSyncPrs(prs, 'cella/sync');

    expect(result.map((p) => p.number)).toEqual([1, 3]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterSyncPrs([pr(1, 'main'), pr(2, 'dev')], 'cella/sync')).toEqual([]);
  });

  it('respects a custom prefix', () => {
    const prs = [pr(1, 'cella/sync/x'), pr(2, 'my/prefix/y')];
    expect(filterSyncPrs(prs, 'my/prefix').map((p) => p.number)).toEqual([2]);
  });
});

describe('buildMergeArgs', () => {
  it('squash-merges immediately by default', () => {
    expect(buildMergeArgs('42')).toEqual(['pr', 'merge', '42', '--squash']);
  });

  it('adds --auto for auto-merge and --delete-branch when requested', () => {
    expect(buildMergeArgs('cella/sync/x', { auto: true, deleteBranch: true })).toEqual([
      'pr',
      'merge',
      'cella/sync/x',
      '--squash',
      '--auto',
      '--delete-branch',
    ]);
  });

  it('can delete the branch without enabling auto-merge', () => {
    expect(buildMergeArgs('7', { deleteBranch: true })).toEqual(['pr', 'merge', '7', '--squash', '--delete-branch']);
  });
});
