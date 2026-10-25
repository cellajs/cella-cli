/**
 * Tests for the review page.
 *
 * `reviewSections` picks the files of each terminal list with the refs their diffs run over,
 * `writeReviewPage` renders them into the git dir and lists what it cannot render,
 * `reportReviewPage` writes the page and opens it in the browser only for a sync on a terminal,
 * and `reviewStep` is the `next steps` entry for it. A fake `open`/`xdg-open` on PATH records the
 * opener's arguments.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzedFile, MergeResult } from '../src/config/types';
import { analyzeRefs } from '../src/services/analyze-core';
import {
  existingSyncReviewPage,
  type ReviewPageReport,
  reportReviewPage,
  reviewSections,
  reviewStep,
  writeReviewPage,
} from '../src/services/review-page';
import { getEnv } from '../src/utils/env';
import { groupIgnoredUpstreamChanges } from '../src/utils/overrides';
import { createRepo, exec, write } from './helpers/test-env';

/**
 * Repo with a `main` (fork) and `upstream` branch off one base commit:
 * - pinned.css:   both changed            → dropped (protected but behind)
 * - masking.css:  pinned, upstream only   → masking pin
 * - stale.css:    pinned, fork dropped b  → ahead, 1 upstream line absent
 * - own/new.ts:   ignored, upstream added → ignored path changed upstream
 * - drift.ts:     fork changed            → drifted
 * - drift.bin:    fork changed, binary    → drifted, no text diff
 * - plain.ts:     upstream changed        → behind, on no section
 */
function createScenarioRepo(): string {
  const dir = createRepo('cella-review-page-');
  write(dir, {
    'pinned.css': 'a\nb\n',
    'masking.css': 'a\n',
    'stale.css': 'a\nb\n',
    'drift.ts': 'export const drift = "base";\n',
    'drift.bin': '\0base\0',
    'plain.ts': 'a\n',
  });
  exec('git add -A && git commit -q -m base', dir);

  exec('git checkout -q -b upstream', dir);
  write(dir, {
    'pinned.css': 'a\nb\nupstream-utility\n',
    'masking.css': 'a\nupstream-masked\n',
    'own/new.ts': 'export const added = "upstream";\n',
    'plain.ts': 'a\nupstream\n',
  });
  exec('git add -A && git commit -q -m upstream', dir);

  exec('git checkout -q main', dir);
  write(dir, {
    'pinned.css': 'a\nb\nfork\n',
    'stale.css': 'a\n',
    'drift.ts': 'export const drift = "fork-change";\n',
    'drift.bin': '\0fork\0',
  });
  exec('git add -A && git commit -q -m fork', dir);
  return dir;
}

/** Page text without tags: highlighting splits code into token spans. Strips to a fixed point. */
function visibleText(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text;
}

/** A merge result for the scenario, shaped like the engine's analyze-mode result. */
async function scenarioResult(dir: string): Promise<MergeResult> {
  const base = exec('git rev-parse --short main~1', dir);
  const upstream = exec('git rev-parse --short upstream', dir);
  const files: AnalyzedFile[] = await analyzeRefs(dir, 'main', 'upstream', base, {
    isIgnored: (p) => p.startsWith('own/'),
    isPinned: (p) => p.endsWith('.css'),
  });
  return {
    success: true,
    files,
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
    conflicts: [],
    protectedConflicts: files.filter((f) => f.upstreamChanged).map((f) => f.path),
    upstreamDiffRange: `${base}..${upstream}`,
    ignoredUpstreamChanges: groupIgnoredUpstreamChanges(files, ['own']),
  };
}

describe('review page', () => {
  let repoPath: string;
  let result: MergeResult;
  let binDir: string;
  let argsFile: string;
  let base: string;
  let upstream: string;
  const wasTTY = process.stdout.isTTY;

  beforeEach(async () => {
    repoPath = createScenarioRepo();
    result = await scenarioResult(repoPath);
    [base, upstream] = result.upstreamDiffRange?.split('..') ?? [];

    binDir = fs.mkdtempSync(path.join(path.dirname(repoPath), 'cella-review-bin-'));
    argsFile = path.join(binDir, 'open-args.txt');
    for (const opener of ['open', 'xdg-open']) {
      const shim = path.join(binDir, opener);
      fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPEN_ARGS_FILE"\n`);
      fs.chmodSync(shim, 0o755);
    }
    vi.stubEnv('PATH', `${binDir}:${getEnv('PATH') ?? ''}`);
    vi.stubEnv('OPEN_ARGS_FILE', argsFile);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: wasTTY, configurable: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  /** Make stdout read as a terminal or not; restored in afterEach. */
  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  }

  /** Run `reportReviewPage`, failing the test if it prints anything: the page goes under `next steps`. */
  async function report(command: 'analyze' | 'sync'): Promise<ReviewPageReport | undefined> {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const page = await reportReviewPage(repoPath, result, command);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
    return page;
  }

  describe('reviewSections', () => {
    it('lists the analyze sections, each with the refs its diffs run over, ignored upstream changes under protected', () => {
      const sections = reviewSections(result, 'analyze');

      expect(sections.map((s) => [s.title, s.range, s.paths])).toEqual([
        ['protected but behind upstream', `${base}..${upstream}`, ['pinned.css', 'own/new.ts']],
        ['pinned files that match the previous upstream', `${base}..${upstream}`, ['masking.css']],
        ['protected in fork, upstream lines absent', `HEAD..${upstream}`, ['stale.css']],
        ['drifted from upstream', `${base}..HEAD`, ['drift.bin', 'drift.ts']],
      ]);
    });

    it('limits sync to the upstream changes it did not bring in, dropped files from the merge result', () => {
      const sections = reviewSections({ ...result, protectedConflicts: ['pinned.css', 'package.json'] }, 'sync');

      expect(sections.map((s) => [s.title, s.paths])).toEqual([
        ['protected files kept the fork version', ['pinned.css', 'package.json']],
        ['ignored paths changed upstream', ['own/new.ts']],
        ['pinned files that match the previous upstream', ['masking.css']],
      ]);
    });

    it('returns nothing without a resolved sync range', () => {
      expect(reviewSections({ ...result, upstreamDiffRange: undefined }, 'analyze')).toEqual([]);
    });
  });

  describe('writeReviewPage', () => {
    it("writes one page into the repo's git dir with a diff per file", async () => {
      const page = await writeReviewPage(repoPath, reviewSections(result, 'analyze'), {
        command: 'analyze',
        range: `${base}..${upstream}`,
      });

      expect(page?.path).toBe(path.join(fs.realpathSync(repoPath), '.git', 'cella-diff', 'analyze-review.html'));
      expect(page).toMatchObject({ diffs: 5, listed: 1, sections: 4 });
      const text = visibleText(fs.readFileSync(page?.path ?? '', 'utf-8'));
      for (const title of ['protected but behind upstream', 'drifted from upstream']) expect(text).toContain(title);
      // Each section's diff runs over its own refs: upstream's changes, and the fork's own change.
      for (const line of ['upstream-utility', 'upstream-masked', 'export const added', 'fork-change']) {
        expect(text).toContain(line);
      }
    });

    it('lists a file without a text diff by path', async () => {
      const page = await writeReviewPage(repoPath, reviewSections(result, 'analyze'), {
        command: 'analyze',
        range: `${base}..${upstream}`,
      });

      const html = fs.readFileSync(page?.path ?? '', 'utf-8');
      expect(visibleText(html)).toContain('Not shown here');
      expect(html).toContain('<li><code>drift.bin</code></li>');
    });

    it('lists a patch over the per-file line limit instead of rendering it', async () => {
      const page = await writeReviewPage(
        repoPath,
        reviewSections(result, 'analyze'),
        { command: 'analyze', range: `${base}..${upstream}` },
        { files: 50, lines: 15_000, patchLines: 1 },
      );

      // Every text patch has more than one line, so only listings are left and nothing renders.
      expect(page).toBeUndefined();
    });

    it('lets sections take turns, so a long section cannot fill the page before the next gets a diff', async () => {
      const sections = [
        { title: 'first', hint: '', range: `${base}..${upstream}`, paths: ['pinned.css', 'masking.css', 'plain.ts'] },
        { title: 'second', hint: '', range: `${base}..HEAD`, paths: ['drift.ts'] },
      ];

      const page = await writeReviewPage(
        repoPath,
        sections,
        { command: 'analyze', range: `${base}..${upstream}` },
        { files: 2, lines: 15_000, patchLines: 2_000 },
      );

      expect(page).toMatchObject({ diffs: 2, listed: 2, sections: 2 });
      const html = fs.readFileSync(page?.path ?? '', 'utf-8');
      expect(visibleText(html)).toContain('fork-change');
      expect(html).toContain('<li><code>masking.css</code></li>');
      expect(html).toContain('<li><code>plain.ts</code></li>');
    });

    it('stops rendering at the page line budget and lists the rest', async () => {
      const page = await writeReviewPage(
        repoPath,
        reviewSections(result, 'analyze'),
        { command: 'analyze', range: `${base}..${upstream}` },
        { files: 50, lines: 12, patchLines: 2_000 },
      );

      expect(page?.diffs).toBeGreaterThan(0);
      expect(page?.diffs).toBeLessThan(5);
      expect((page?.diffs ?? 0) + (page?.listed ?? 0)).toBe(6);
    });

    it('writes nothing when no listed file has a diff', async () => {
      const sections = [{ title: 'none', hint: '', range: 'HEAD..HEAD', paths: ['drift.ts'] }];

      expect(await writeReviewPage(repoPath, sections, { command: 'analyze', range: 'HEAD..HEAD' })).toBeUndefined();
    });
  });

  describe('reportReviewPage', () => {
    it('writes the analyze page without opening it', async () => {
      const page = await report('analyze');

      expect(page).toMatchObject({ command: 'analyze', diffs: 5, listed: 1, sections: 4, opened: false });
      expect(page?.path).toContain(path.join('.git', 'cella-diff', 'analyze-review.html'));
      expect(fs.existsSync(argsFile)).toBe(false);
    });

    it('opens the sync page in the browser on a terminal', async () => {
      setTTY(true);

      const page = await report('sync');

      expect(page).toMatchObject({ command: 'sync', diffs: 3, opened: true });
      expect(fs.readFileSync(argsFile, 'utf-8')).toContain('sync-review.html');
    });

    it('never opens the sync page without a terminal', async () => {
      setTTY(false);

      expect(await report('sync')).toMatchObject({ opened: false });
      expect(fs.existsSync(argsFile)).toBe(false);
    });

    it('returns nothing when there is nothing to review', async () => {
      result = { ...result, files: [], protectedConflicts: [], ignoredUpstreamChanges: [] };

      expect(await report('analyze')).toBeUndefined();
    });

    it('finds the page the merge run of a sync wrote, and drops it when a later sync has nothing to review', async () => {
      expect(existingSyncReviewPage(repoPath)).toBeUndefined();

      await report('sync');
      expect(existingSyncReviewPage(repoPath)).toContain('sync-review.html');

      result = { ...result, files: [], protectedConflicts: [], ignoredUpstreamChanges: [] };
      expect(await report('sync')).toBeUndefined();
      expect(existingSyncReviewPage(repoPath)).toBeUndefined();
    });
  });

  describe('reviewStep', () => {
    const page = (overrides: Partial<ReviewPageReport>): ReviewPageReport => ({
      path: '/repo/.git/cella-diff/analyze-review.html',
      command: 'analyze',
      diffs: 24,
      listed: 42,
      sections: 4,
      opened: false,
      ...overrides,
    });
    const plain = (step: { line: string; details?: string[] }) =>
      [step.line, ...(step.details ?? [])].map((line) => stripVTControlCharacters(line));

    it('prints the page as a file URL in full, with what is on it', () => {
      expect(plain(reviewStep(page({})))).toEqual([
        'file:///repo/.git/cella-diff/analyze-review.html',
        '24 diffs in 4 sections · 42 listed without a diff',
      ]);
    });

    it('says what a sync page shows and that it opened', () => {
      const step = reviewStep(page({ command: 'sync', diffs: 7, listed: 0, opened: true }));

      expect(plain(step)[1]).toBe('7 diffs of upstream changes that did not arrive · opened in the browser');
    });

    it('describes a page an earlier run wrote without counts', () => {
      expect(plain(reviewStep('/repo/.git/cella-diff/sync-review.html'))[1]).toBe(
        'upstream changes the sync did not bring in, from the merge run',
      );
    });
  });
});
