/**
 * Tests for protected-but-behind detection.
 *
 * A pinned/ignored file wins whole-file on conflict, so when upstream ALSO changed it since the
 * merge-base, upstream's hunks are dropped silently. `analyzeRefs` flags exactly those files
 * (`upstreamChanged` + `upstreamChangedLines`), `findProtectedBehind` selects them for display,
 * and `printSyncComplete` lists `MergeResult.protectedConflicts` at the end of a sync. The diffs
 * themselves are on the review page, so the list prints no `git diff` lines. The analyze section
 * is covered in `analyze-report.test.ts`.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyzedFile, MergeResult } from '../src/config/types';
import { analyzeRefs } from '../src/services/analyze-core';
import { findProtectedBehind, printSyncComplete } from '../src/utils/display';
import { getMergeBase } from '../src/utils/git';
import { captureInfo, createRepo, exec, analyzedFile as file, write } from './helpers/test-env';

/**
 * Repo with a `main` (fork) and `upstream` branch off one base commit:
 * - pinned.css:    both changed (upstream +3 −1)      → flagged, 4 lines
 * - only-fork.css: fork changed, upstream untouched  → plain ahead
 * - masking.css:   upstream changed, fork untouched  → behind (masking pin, not flagged)
 * - own/mine.ts:   ignored, both changed             → flagged
 * - plain.ts:      unprotected, upstream changed     → behind, never flagged
 * - stale.css:     pinned, fork dropped 2 base lines, upstream untouched → ahead, 2 lines absent
 * - own/stale.ts:  ignored, same shape as stale.css  → ignored, never annotated
 */
function createScenarioRepo(): string {
  const dir = createRepo('cella-protected-behind-');

  write(dir, {
    'pinned.css': 'a\nb\nc\n',
    'only-fork.css': 'a\n',
    'masking.css': 'a\n',
    'own/mine.ts': 'a\n',
    'plain.ts': 'a\n',
    'stale.css': 'a\nb\nc\n',
    'own/stale.ts': 'a\nb\n',
  });
  exec('git add -A && git commit -q -m base', dir);

  exec('git checkout -q -b upstream', dir);
  write(dir, {
    'pinned.css': 'a\nb\nx\ny\nz\n', // c removed, x y z added
    'masking.css': 'a\nupstream\n',
    'own/mine.ts': 'a\nupstream\n',
    'plain.ts': 'a\nupstream\n',
  });
  exec('git add -A && git commit -q -m upstream', dir);

  exec('git checkout -q main', dir);
  write(dir, {
    'pinned.css': 'a\nb\nc\nfork\n',
    'only-fork.css': 'a\nfork\n',
    'own/mine.ts': 'a\nfork\n',
    'stale.css': 'a\nfork\n', // b, c gone: 2 upstream lines absent
    'own/stale.ts': 'a\n',
  });
  exec('git add -A && git commit -q -m fork', dir);

  return dir;
}

describe('analyzeRefs upstreamChanged', () => {
  let repoPath: string;
  let byPath: Map<string, AnalyzedFile>;

  beforeEach(async () => {
    repoPath = createScenarioRepo();
    const mergeBase = await getMergeBase(repoPath, 'main', 'upstream');
    const files = await analyzeRefs(repoPath, 'main', 'upstream', mergeBase, {
      isIgnored: (p) => p.startsWith('own/'),
      isPinned: (p) => p.endsWith('.css'),
    });
    byPath = new Map(files.map((f) => [f.path, f]));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('flags a pinned file both sides changed and counts the upstream lines', () => {
    const pinned = byPath.get('pinned.css');
    expect(pinned?.status).toBe('pinned');
    expect(pinned?.upstreamChanged).toBe(true);
    expect(pinned?.upstreamChangedLines).toBe(4);
  });

  it('leaves a pinned file only the fork changed as plain ahead', () => {
    const ahead = byPath.get('only-fork.css');
    expect(ahead?.status).toBe('ahead');
    expect(ahead?.upstreamChanged).toBeUndefined();
    expect(ahead?.upstreamChangedLines).toBeUndefined();
  });

  it('does not flag a masking pin (fork copy still equals base)', () => {
    const masking = byPath.get('masking.css');
    expect(masking?.status).toBe('behind');
    expect(masking?.isPinned).toBe(true);
    expect(masking?.upstreamChanged).toBeUndefined();
  });

  it('flags an ignored file both sides changed', () => {
    const ignored = byPath.get('own/mine.ts');
    expect(ignored?.status).toBe('ignored');
    expect(ignored?.upstreamChanged).toBe(true);
    expect(ignored?.upstreamChangedLines).toBe(1);
  });

  it('never flags unprotected files', () => {
    const plain = byPath.get('plain.ts');
    expect(plain?.status).toBe('behind');
    expect(plain?.upstreamChanged).toBeUndefined();
  });

  it('counts upstream lines absent from a pinned ahead file', () => {
    const stale = byPath.get('stale.css');
    expect(stale?.status).toBe('ahead');
    expect(stale?.upstreamLinesAbsent).toBe(2);
    // fork only added lines: nothing absent
    expect(byPath.get('only-fork.css')?.upstreamLinesAbsent).toBe(0);
  });

  it('never counts absent lines for ignored or unprotected files', () => {
    expect(byPath.get('own/stale.ts')?.status).toBe('ignored');
    expect(byPath.get('own/stale.ts')?.upstreamLinesAbsent).toBeUndefined();
    expect(byPath.get('plain.ts')?.upstreamLinesAbsent).toBeUndefined();
  });
});

describe('findProtectedBehind', () => {
  it('selects flagged files and skips managed and generated ones', () => {
    const files = [
      file({ path: 'frontend/src/styling/tailwind.css', status: 'pinned', isPinned: true, upstreamChanged: true }),
      file({ path: 'own/a.ts', status: 'ignored', isIgnored: true, upstreamChanged: true }),
      file({ path: 'package.json', status: 'pinned', isPinned: true, upstreamChanged: true }),
      file({ path: 'sdk/gen/types.gen.ts', status: 'ignored', isIgnored: true, upstreamChanged: true }),
      file({ path: 'ahead.ts', status: 'ahead', isPinned: true }),
      file({ path: 'plain.ts', status: 'behind' }),
    ];
    expect(findProtectedBehind(files).map((f) => f.path)).toEqual(['frontend/src/styling/tailwind.css', 'own/a.ts']);
  });
});

describe('printSyncComplete protected conflicts', () => {
  const baseResult = (): MergeResult => ({
    success: true,
    files: [],
    conflicts: [],
    summary: {
      managed: 0,
      identical: 0,
      ahead: 0,
      local: 0,
      drifted: 0,
      behind: 0,
      diverged: 0,
      pinned: 0,
      ignored: 0,
      deleted: 0,
      renamed: 0,
    },
  });

  const capture = (result: MergeResult) => captureInfo(() => printSyncComplete(result));

  it('lists dropped protected files with their upstream line count and the hint', () => {
    const result = baseResult();
    result.files = [
      file({
        path: 'frontend/src/styling/tailwind.css',
        status: 'pinned',
        isPinned: true,
        upstreamChanged: true,
        upstreamChangedLines: 21,
      }),
    ];
    result.protectedConflicts = ['frontend/src/styling/tailwind.css'];
    result.upstreamDiffRange = 'e9a8d485e..a81e3353b';

    const out = capture(result);
    expect(out).toContain('1 protected file kept the fork version');
    expect(out).toContain('frontend/src/styling/tailwind.css');
    expect(out).toContain('21 lines changed upstream');
    expect(out).toContain('adopt what you need');
    expect(out).not.toContain('git diff');
  });

  it('stays silent when nothing was dropped', () => {
    const out = capture(baseResult());
    expect(out).not.toContain('protected');
  });
});
