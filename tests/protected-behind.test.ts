/**
 * Tests for protected-but-behind detection.
 *
 * A pinned/ignored file wins whole-file on conflict, so when upstream ALSO changed it since the
 * merge-base, upstream's hunks are dropped silently. `analyzeRefs` flags exactly those files
 * (`upstreamChanged` + `upstreamChangedLines`), `findProtectedBehind` selects them for display,
 * and `printSyncComplete` lists `MergeResult.protectedConflicts` at the end of a sync. Both lists
 * end with one `git diff <last-sync>..<upstream>` line per pinned/ignored entry.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzedFile, FileStatus, MergeResult } from '../src/config/types';
import { analyzeRefs } from '../src/services/analyze-core';
import { findProtectedBehind, printAnalysisFileGroups, printSyncComplete } from '../src/utils/display';
import { getMergeBase } from '../src/utils/git';

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

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
function createRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-protected-behind-'));
  exec('git init -b main', dir);
  exec('git config user.email "test@test.com" && git config user.name "Test"', dir);

  write(dir, 'pinned.css', 'a\nb\nc\n');
  write(dir, 'only-fork.css', 'a\n');
  write(dir, 'masking.css', 'a\n');
  write(dir, 'own/mine.ts', 'a\n');
  write(dir, 'plain.ts', 'a\n');
  write(dir, 'stale.css', 'a\nb\nc\n');
  write(dir, 'own/stale.ts', 'a\nb\n');
  exec('git add -A && git commit -q -m base', dir);

  exec('git checkout -q -b upstream', dir);
  write(dir, 'pinned.css', 'a\nb\nx\ny\nz\n'); // c removed, x y z added
  write(dir, 'masking.css', 'a\nupstream\n');
  write(dir, 'own/mine.ts', 'a\nupstream\n');
  write(dir, 'plain.ts', 'a\nupstream\n');
  exec('git add -A && git commit -q -m upstream', dir);

  exec('git checkout -q main', dir);
  write(dir, 'pinned.css', 'a\nb\nc\nfork\n');
  write(dir, 'only-fork.css', 'a\nfork\n');
  write(dir, 'own/mine.ts', 'a\nfork\n');
  write(dir, 'stale.css', 'a\nfork\n'); // b, c gone: 2 upstream lines absent
  write(dir, 'own/stale.ts', 'a\n');
  exec('git add -A && git commit -q -m fork', dir);

  return dir;
}

function file(overrides: Partial<AnalyzedFile> & { path: string; status: FileStatus }): AnalyzedFile {
  return { isIgnored: false, isPinned: false, existsInFork: true, existsInUpstream: true, ...overrides };
}

describe('analyzeRefs upstreamChanged', () => {
  let repoPath: string;
  let byPath: Map<string, AnalyzedFile>;

  beforeEach(async () => {
    repoPath = createRepo();
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

describe('printAnalysisFileGroups upstream lines absent', () => {
  function capture(files: AnalyzedFile[], diffSource?: Parameters<typeof printAnalysisFileGroups>[2]): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      printAnalysisFileGroups(files, {}, diffSource);
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('ends the protected-but-behind section with one range diff per entry that holds a listed file', () => {
    const files = [
      file({ path: 'shared/config/default.ts', status: 'ignored', isIgnored: true, upstreamChanged: true }),
      file({ path: 'shared/config/staging.ts', status: 'ignored', isIgnored: true, upstreamChanged: true }),
      file({ path: 'frontend/src/my styles.css', status: 'pinned', isPinned: true, upstreamChanged: true }),
      file({ path: 'package.json', status: 'pinned', isPinned: true, upstreamChanged: true }),
    ];
    const out = capture(files, {
      upstreamDiffRange: '1a2b3c4..5d6e7f8',
      protectedUpstreamChanges: [
        { entry: 'shared/config', paths: ['shared/config/default.ts', 'shared/config/staging.ts'] },
        { entry: 'frontend/src/my styles.css', paths: ['frontend/src/my styles.css'] },
        // managed files are not listed in this section, so their entry gets no line
        { entry: 'package.json', paths: ['package.json'] },
      ],
    });

    expect(out).toContain('what upstream changed since the last sync, per pinned/ignored entry:');
    expect(out.match(/git diff 1a2b3c4\.\.5d6e7f8 -- shared\/config$/gm)).toHaveLength(1);
    expect(out).toContain(`git diff 1a2b3c4..5d6e7f8 -- 'frontend/src/my styles.css'`);
    expect(out).not.toContain('-- package.json');
  });

  it('prints no diff lines without a range', () => {
    const files = [file({ path: 'own/a.ts', status: 'ignored', isIgnored: true, upstreamChanged: true })];
    expect(capture(files)).not.toContain('git diff');
    expect(capture(files, { protectedUpstreamChanges: [{ entry: 'own', paths: ['own/a.ts'] }] })).not.toContain(
      'git diff',
    );
  });

  it('annotates pinned ahead files with a positive count and prints the hint', () => {
    const out = capture([
      file({ path: 'frontend/src/styling/tailwind.css', status: 'ahead', isPinned: true, upstreamLinesAbsent: 7 }),
      file({ path: 'clean.css', status: 'ahead', isPinned: true, upstreamLinesAbsent: 0 }),
    ]);
    expect(out).toContain('frontend/src/styling/tailwind.css');
    expect(out).toContain('7 upstream lines absent');
    expect(out).toMatch(/clean\.css\n/);
    expect(out).toContain('diff and decide');
  });
});

describe('findProtectedBehind', () => {
  it('selects flagged files and skips managed ones', () => {
    const files = [
      file({ path: 'frontend/src/styling/tailwind.css', status: 'pinned', isPinned: true, upstreamChanged: true }),
      file({ path: 'own/a.ts', status: 'ignored', isIgnored: true, upstreamChanged: true }),
      file({ path: 'package.json', status: 'pinned', isPinned: true, upstreamChanged: true }),
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

  function capture(result: MergeResult): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      printSyncComplete(result);
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

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

    const out = capture(result);
    expect(out).toContain('1 protected file kept the fork version');
    expect(out).toContain('frontend/src/styling/tailwind.css');
    expect(out).toContain('21 lines changed upstream');
    expect(out).toContain('adopt what you need');
    expect(out).not.toContain('git diff');
  });

  it('prints one range diff per pinned/ignored entry, not per file', () => {
    const result = baseResult();
    result.files = [
      file({ path: 'shared/config/default.ts', status: 'ignored', isIgnored: true, upstreamChanged: true }),
      file({ path: 'shared/config/staging.ts', status: 'ignored', isIgnored: true, upstreamChanged: true }),
      file({ path: 'frontend/src/styling/tailwind.css', status: 'pinned', isPinned: true, upstreamChanged: true }),
    ];
    result.protectedConflicts = result.files.map((f) => f.path);
    result.upstreamDiffRange = 'e9a8d485e..a81e3353b';
    result.protectedUpstreamChanges = [
      { entry: 'shared/config', paths: ['shared/config/default.ts', 'shared/config/staging.ts'] },
      { entry: 'frontend/src/styling/tailwind.css', paths: ['frontend/src/styling/tailwind.css'] },
    ];

    const out = capture(result);
    expect(out).toContain('3 protected files kept the fork version');
    expect(out).toContain('what upstream changed since the last sync, per pinned/ignored entry:');
    expect(out.match(/git diff /g)).toHaveLength(2);
    expect(out).toContain('    git diff e9a8d485e..a81e3353b -- shared/config');
    expect(out).toContain('    git diff e9a8d485e..a81e3353b -- frontend/src/styling/tailwind.css');
  });

  it('stays silent when nothing was dropped', () => {
    const out = capture(baseResult());
    expect(out).not.toContain('protected');
  });
});
