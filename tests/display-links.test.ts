/**
 * Unit tests for CLI output link formatting.
 *
 * Covers the pure display helpers `formatFetchedUpstreamDetail` and
 * `formatMergeInProgressDetail`, including the VS Code open-file links for
 * auto-merged files.
 */
import { describe, expect, it } from 'vitest';
import { formatFetchedUpstreamDetail, formatMergeInProgressDetail } from '../src/utils/display';

const VSCODE_FILE = 'vscode://file';

function makeCommits(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    hash: `${i}`.padStart(40, '0'),
    message: `commit ${i + 1}`,
    date: `${i + 1} minutes ago`,
  }));
}

describe('formatFetchedUpstreamDetail', () => {
  it('counts the commits in singular or plural, without hyperlink escapes when there is no GitHub URL', () => {
    const out = formatFetchedUpstreamDetail(1, makeCommits(1));
    expect(out).toContain('1 new commit since last merge');
    expect(out).not.toContain('\x1b]8;;');
    expect(formatFetchedUpstreamDetail(3, makeCommits(3))).toContain('3 new commits since last merge');
  });

  it('caps the shown commits and reports the remainder', () => {
    const out = formatFetchedUpstreamDetail(5, makeCommits(5), undefined, 2);
    expect(out).toContain('commit 1');
    expect(out).toContain('commit 2');
    expect(out).not.toContain('commit 3');
    expect(out).toContain('... and 3 more');
  });

  it('embeds clickable commit links when a GitHub URL is provided', () => {
    const commits = makeCommits(1);
    const out = formatFetchedUpstreamDetail(1, commits, 'https://github.com/cellajs/cella');
    expect(out).toContain(`https://github.com/cellajs/cella/commit/${commits[0].hash}`);
  });
});

describe('formatMergeInProgressDetail', () => {
  it('shows only the conflict count when there are no auto-merged files', () => {
    const out = formatMergeInProgressDetail(2, [], {});
    expect(out).toContain('2 conflicts to resolve in IDE');
    expect(out).not.toContain('auto-merged files');
  });

  it('caps the auto-merged file list and reports the remainder', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const out = formatMergeInProgressDetail(1, files, {}, 2);
    expect(out).toContain('auto-merged files (3):');
    expect(out).toContain('... + 1 more');
  });

  it('links auto-merged files to VS Code from the fork path, and prints the bare path without one', () => {
    expect(formatMergeInProgressDetail(1, ['a.ts'], { forkPath: '/tmp/fork' })).toContain(
      `${VSCODE_FILE}/tmp/fork/a.ts`,
    );

    const bare = formatMergeInProgressDetail(1, ['a.ts'], {});
    expect(bare).toContain('  - a.ts');
    expect(bare).not.toContain(VSCODE_FILE);
  });
});
