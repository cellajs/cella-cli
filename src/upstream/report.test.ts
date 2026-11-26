/**
 * Unit tests for the upgrade report's step formatting: `formatUpstreamCommits` and
 * `formatMergeInProgressDetail`, including the VS Code open-file links for auto-merged files.
 */

import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { formatCheckoutStep, formatMergeInProgressDetail, formatUpstreamCommits, formatUpstreamStep } from './report';

const vscodeFile = 'vscode://file';

describe('formatUpstreamCommits', () => {
  const commit = (hash: string, message: string) => ({ hash: hash.padEnd(40, '0'), message, date: '' });

  it('links the hash and the PR number when upstream is on GitHub', () => {
    const [line] = formatUpstreamCommits(1, [commit('b374861', 'fix: x (#7)')], 'https://github.com/cellajs/cella');

    expect(line).toContain(`https://github.com/cellajs/cella/commit/${'b374861'.padEnd(40, '0')}`);
    expect(line).toContain('https://github.com/cellajs/cella/pull/7');
  });

  it('prints no link escapes without a GitHub URL', () => {
    expect(formatUpstreamCommits(1, [commit('b374861', 'fix: x')]).join('\n')).not.toContain('\x1b]8;;');
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

  it('links auto-merged files to VS Code from the app path, and prints the bare path without one', () => {
    expect(formatMergeInProgressDetail(1, ['a.ts'], { repoRoot: '/tmp/app' })).toContain(`${vscodeFile}/tmp/app/a.ts`);

    const bare = formatMergeInProgressDetail(1, ['a.ts'], {});
    expect(bare).toContain('  - a.ts');
    expect(bare).not.toContain(vscodeFile);
  });
});

describe('formatCheckoutStep', () => {
  const checkout = {
    branch: 'main',
    headSha: 'ac6106a',
    changeCount: 0,
    tracking: { tracking: 'origin/main', ahead: 0, behind: 0 },
  };

  it('says the tree is clean, and leaves out a branch in step with its remote', () => {
    expect(stripVTControlCharacters(formatCheckoutStep(checkout))).toBe('main @ ac6106a · clean');
  });

  it('counts uncommitted changes and how far the branch is from its remote', () => {
    const out = formatCheckoutStep({
      ...checkout,
      changeCount: 1,
      tracking: { tracking: 'origin/main', ahead: 2, behind: 0 },
    });

    expect(stripVTControlCharacters(out)).toBe('main @ ac6106a · 1 uncommitted change, not included in the analysis · 2 ahead, 0 behind origin/main');
  });
});

describe('formatUpstreamStep', () => {
  const upstream = { label: 'main', sha: 'b374861', baseSha: '3d56cca', pinned: false, commitCount: 0, commits: [] };

  it('says when upstream has nothing new', () => {
    expect(stripVTControlCharacters(formatUpstreamStep(upstream))).toBe('main @ b374861 · no new commits since the last upgrade');
  });

  it('counts the commits since the last upgrade and marks a pinned ref', () => {
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
