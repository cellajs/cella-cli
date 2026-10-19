/**
 * Tests for the shared diff helpers.
 *
 * Covers `gitDiffFile`, `renderDiffPage` (static, self-contained HTML from
 * patches in sections), `writeDiffPage` (a page in the git dir) and
 * `openInBrowser` (platform opener). We shim `open`/`xdg-open` on PATH so the
 * opener's arguments are recorded instead of launching a real browser.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitDiffFile, openInBrowser, renderDiffPage, writeDiffPage } from '../src/utils/diff';
import { getEnv } from '../src/utils/env';
import { exec, GIT_USER } from './helpers/test-env';

describe('diff helpers', () => {
  let testDir: string;
  let forkPath: string;
  let binDir: string;
  let argsFile: string;
  let originalPath: string | undefined;

  /** Working-tree patch (HEAD vs modified x.ts) with standard a/ b/ prefixes. */
  function makePatch(): string {
    fs.writeFileSync(path.join(forkPath, 'x.ts'), 'const side = "fork content";\n');
    return gitDiffFile(forkPath, 'HEAD', 'x.ts').toString();
  }

  /** Page text without tags: highlighting splits lines into token spans. */
  function visibleText(html: string): string {
    // Tags are stripped repeatedly until a fixed point so nested/partial
    // brackets can't survive a single pass (CodeQL js/incomplete-multi-character-sanitization).
    let text = html;
    let previous: string;
    do {
      previous = text;
      text = text.replace(/<[^>]*>/g, '');
    } while (text !== previous);
    return text;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-diff-test-'));
    forkPath = path.join(testDir, 'fork');
    binDir = path.join(testDir, 'bin');
    argsFile = path.join(testDir, 'open-args.txt');
    fs.mkdirSync(binDir);

    // Fake `open` (darwin) and `xdg-open` (linux) that record their args.
    for (const opener of ['open', 'xdg-open']) {
      const shim = path.join(binDir, opener);
      fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPEN_ARGS_FILE"\n`);
      fs.chmodSync(shim, 0o755);
    }

    // Real git repo with a committed file used as the upstream side.
    fs.mkdirSync(forkPath);
    exec('git init -b main', forkPath);
    exec(GIT_USER, forkPath);
    fs.writeFileSync(path.join(forkPath, 'x.ts'), 'const side = "upstream content";\n');
    exec('git add -A && git commit -m "initial"', forkPath);

    originalPath = getEnv('PATH');
    vi.stubEnv('PATH', `${binDir}:${originalPath ?? ''}`);
    vi.stubEnv('OPEN_ARGS_FILE', argsFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('gitDiffFile', () => {
    it('keeps standard a/ b/ prefixes (renderer input)', () => {
      const patch = makePatch();

      expect(patch).toContain('--- a/x.ts');
      expect(patch).toContain('+++ b/x.ts');
    });

    it('returns empty output for an unchanged file', () => {
      expect(gitDiffFile(forkPath, 'HEAD', 'x.ts').length).toBe(0);
    });

    it('throws a clear error for an invalid ref', () => {
      expect(() => gitDiffFile(forkPath, 'no-such-ref', 'x.ts')).toThrow();
    });
  });

  describe('renderDiffPage', () => {
    it('renders a complete, self-contained page with both sides of the change', async () => {
      const html = await renderDiffPage([{ files: [{ path: 'x.ts', patch: makePatch() }] }], {
        title: 'x.ts',
        note: 'cella ← → myfork',
      });

      expect(html).toContain('<!doctype html>');
      const text = visibleText(html);
      expect(text).toContain('upstream content');
      expect(text).toContain('fork content');
      // Self-contained: styles inline, no external requests.
      expect(html).toContain('<style');
      expect(html).not.toContain('src="http');
      // The fragment must live in declarative shadow DOM: the library's palette
      // (red/green line backgrounds) is defined on :host, which matches nothing
      // outside a shadow root.
      expect(html).toContain('shadowrootmode="open"');
      expect(text).toContain('cella ← → myfork');
      // One untitled section: no section index.
      expect(html).not.toContain('<nav>');
    });

    it('renders titled sections with counts, an index, and the files left off the page', async () => {
      const patch = makePatch();
      const html = await renderDiffPage(
        [
          { title: 'first', hint: 'what these show', files: [{ path: 'x.ts', patch }] },
          { title: 'second', files: [{ path: 'x.ts', patch }], omitted: ['git diff a..b -- y.bin'] },
        ],
        { title: 'analyze review' },
      );

      expect(html.match(/shadowrootmode="open"/g)).toHaveLength(2);
      expect(html).toContain('<a href="#section-1">first</a>');
      expect(html).toContain('<a href="#section-2">second</a>');
      const text = visibleText(html);
      expect(text).toContain('first · 1 file');
      expect(text).toContain('second · 2 files');
      expect(text).toContain('what these show');
      expect(text).toContain('git diff a..b -- y.bin');
    });

    it('escapes HTML in the title, note, section text and omitted lines', async () => {
      const html = await renderDiffPage(
        [{ title: '<b>t</b>', hint: 'a & b', files: [{ path: 'x.ts', patch: makePatch() }], omitted: ['"q"'] }],
        { title: '<script>alert(1)</script>', note: 'fork "quoted"' },
      );

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&lt;b&gt;t&lt;/b&gt;');
      expect(html).toContain('a &amp; b');
      expect(html).toContain('&quot;q&quot;');
    });
  });

  describe('writeDiffPage', () => {
    it("writes the page into the repo's git dir under a stable, flat name", async () => {
      const pagePath = await writeDiffPage(
        [{ files: [{ path: 'x.ts', patch: makePatch() }] }],
        { title: 'x.ts' },
        forkPath,
        'src/utils/x.ts',
      );

      expect(pagePath).toBe(path.join(fs.realpathSync(forkPath), '.git', 'cella-diff', 'src-utils-x.ts.html'));
      expect(fs.readFileSync(pagePath, 'utf-8')).toContain('<!doctype html>');
      // Inside the git dir: the page never shows up as an untracked file.
      expect(exec('git status --porcelain', forkPath)).toBe('M x.ts');
    });
  });

  describe('openInBrowser', () => {
    it('passes the target to the platform opener and reports success', () => {
      expect(openInBrowser('/tmp/page.html')).toBe(true);
      expect(fs.readFileSync(argsFile, 'utf-8')).toContain('/tmp/page.html');
    });

    it('returns false when the opener fails', () => {
      for (const opener of ['open', 'xdg-open']) fs.writeFileSync(path.join(binDir, opener), '#!/bin/sh\nexit 1\n');

      expect(openInBrowser('/tmp/page.html')).toBe(false);
    });
  });
});
