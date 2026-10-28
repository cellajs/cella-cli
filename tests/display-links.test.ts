/**
 * Unit tests for CLI output link formatting.
 *
 * Covers the pure display helpers `formatUpstreamCommits` and
 * `formatMergeInProgressDetail`, including the VS Code open-file links for
 * auto-merged files.
 */

import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  formatCheckoutStep,
  formatMergeInProgressDetail,
  formatUpstreamCommits,
  formatUpstreamStep,
} from '../src/utils/display';

const VSCODE_FILE = 'vscode://file';

describe('formatUpstreamCommits', () => {
  const NOW_MS = 1_800_000_000_000;
  const at = (minutesAgo: number) => NOW_MS / 1000 - minutesAgo * 60;
  const commit = (hash: string, message: string, minutesAgo: number) => ({
    hash: hash.padEnd(40, '0'),
    message,
    date: '',
    timestamp: at(minutesAgo),
  });
  const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line));

  it('lists the newest first, one line each, with the PR number and the age in columns', () => {
    const commits = [
      commit('18add42', 'chore(main): release 0.23.0 (#1511)', 13 * 60),
      commit('3dcf39c', 'chore(db)!: migration snapshots are stored as diffs (#1515)', 180),
      commit('b374861', 'refactor!: migration notes become alignments, and start empty (#1519)', 0),
    ];

    expect(plain(formatUpstreamCommits(3, commits, undefined, { columns: 80, nowMs: NOW_MS }))).toEqual([
      'b374861  refactor!: migration notes become alignments,…  #1519  now',
      '3dcf39c  chore(db)!: migration snapshots are stored as…  #1515   3h',
      '18add42  chore(main): release 0.23.0                     #1511  13h',
    ]);
  });

  it('cuts long subjects to the width and counts the commits it leaves out', () => {
    const commits = Array.from({ length: 3 }, (_, i) => commit(`${i}`, `feat: ${'word '.repeat(30)}${i}`, 10 - i));

    const lines = plain(formatUpstreamCommits(12, commits, undefined, { columns: 80, max: 2, nowMs: NOW_MS }));

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^2000000 {2}feat: word .*…/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80 - 13);
    expect(lines[2]).toBe('+ 10 earlier');
  });

  it('links the hash and the PR number when upstream is on GitHub', () => {
    const [line] = formatUpstreamCommits(1, [commit('b374861', 'fix: x (#7)', 1)], 'https://github.com/cellajs/cella');

    expect(line).toContain(`https://github.com/cellajs/cella/commit/${'b374861'.padEnd(40, '0')}`);
    expect(line).toContain('https://github.com/cellajs/cella/pull/7');
  });

  it('prints no link escapes without a GitHub URL', () => {
    expect(formatUpstreamCommits(1, [commit('b374861', 'fix: x', 1)]).join('\n')).not.toContain('\x1b]8;;');
  });
});

describe('formatMergeInProgressDetail', () => {
  it('shows only the conflict count when there are no auto-merged files', () => {
    const out = formatMergeInProgressDetail(2, [], {});
    expect(out).toContain('2 conflicts to resolve in your editor');
    expect(formatMergeInProgressDetail(1, [], {})).toContain('1 conflict to resolve in your editor');
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

describe('formatCheckoutStep', () => {
  const checkout = {
    forkPath: process.cwd(),
    branch: 'main',
    headSha: 'ac6106a',
    changeCount: 0,
    upstream: { upstream: 'origin/main', ahead: 0, behind: 0 },
  };

  it('says the tree is clean, and leaves out a branch in step with its remote', () => {
    expect(stripVTControlCharacters(formatCheckoutStep(checkout))).toBe('main @ ac6106a · clean');
  });

  it('counts uncommitted changes and how far the branch is from its remote', () => {
    const out = formatCheckoutStep({
      ...checkout,
      changeCount: 1,
      upstream: { upstream: 'origin/main', ahead: 2, behind: 0 },
    });

    expect(stripVTControlCharacters(out)).toBe(
      'main @ ac6106a · 1 uncommitted change, not included in the analysis · 2 ahead, 0 behind origin/main',
    );
  });

  it('names the repo when it is not the current directory', () => {
    expect(stripVTControlCharacters(formatCheckoutStep({ ...checkout, forkPath: '/elsewhere/fork' }))).toBe(
      'main @ ac6106a · clean\n/elsewhere/fork',
    );
  });
});

describe('formatUpstreamStep', () => {
  const upstream = { label: 'main', sha: 'b374861', baseSha: '3d56cca', pinned: false, commitCount: 0, commits: [] };

  it('says when upstream has nothing new', () => {
    expect(stripVTControlCharacters(formatUpstreamStep(upstream))).toBe(
      'main @ b374861 · no new commits since the last upgrade',
    );
  });

  it('counts the commits since the last sync and marks a pinned ref', () => {
    const out = formatUpstreamStep({
      ...upstream,
      pinned: true,
      commitCount: 1,
      commits: [{ hash: 'b374861'.padEnd(40, '0'), message: 'fix: x (#7)', date: '' }],
    });

    const [first, commit] = stripVTControlCharacters(out).split('\n');
    expect(first).toBe('main @ b374861 · --ref · 1 new commit since the last upgrade at 3d56cca');
    expect(commit).toMatch(/^b374861 {2}fix: x +#7$/);
  });
});
