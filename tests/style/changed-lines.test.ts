import { describe, expect, it } from 'vitest';
import { changedLinesFromDiff, onChangedLines } from '../../src/tools/style/changed-lines';

const diff = [
  'diff --git a/docs/a.md b/docs/a.md',
  '--- a/docs/a.md',
  '+++ b/docs/a.md',
  '@@ -3 +3 @@',
  '+changed line three',
  '@@ -10,2 +11,3 @@',
  '+eleven',
  '+twelve',
  '+thirteen',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,0 +2,2 @@',
  '+two',
  '+three',
].join('\n');

describe('changed lines', () => {
  it('reads the added side of every hunk, one line when the count is absent', () => {
    const lines = changedLinesFromDiff(diff);
    expect([...lines.get('docs/a.md')!].sort((a, b) => a - b)).toEqual([3, 11, 12, 13]);
    expect([...lines.get('src/b.ts')!]).toEqual([2, 3]);
  });

  it('keeps a ratcheted finding only on a changed line or in an untracked file, and every other finding', () => {
    const rules = new Set(['consequence-tail']);
    const finding = (file: string, line: number, rule = 'consequence-tail') => ({
      file,
      line,
      column: 1,
      rule,
      message: '',
    });
    const findings = [
      finding('docs/a.md', 3),
      finding('docs/a.md', 4),
      finding('docs/new.md', 9),
      finding('docs/a.md', 4, 'em-dash'),
    ];
    const kept = onChangedLines(findings, rules, changedLinesFromDiff(diff), new Set(['docs/new.md']));
    expect(kept.map(({ file, line, rule }) => `${file}:${line}:${rule}`)).toEqual([
      'docs/a.md:3:consequence-tail',
      'docs/new.md:9:consequence-tail',
      'docs/a.md:4:em-dash',
    ]);
    expect(onChangedLines(findings, rules, null, new Set()).map(({ rule }) => rule)).toEqual(['em-dash']);
  });
});
