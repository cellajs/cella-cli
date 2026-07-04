/**
 * Tests for the shared diff helpers.
 *
 * Covers `gitDiffFile` prefix labeling, `renderDiffPage` (static, self-contained
 * HTML from a patch), and `openDiffInBrowser` (temp-file write + platform
 * opener). We shim `open`/`xdg-open` on PATH so the opener's arguments are
 * recorded instead of launching a real browser.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitDiffFile, openDiffInBrowser, renderDiffPage } from '../src/utils/diff';
import { getEnv } from '../src/utils/env';

function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

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
    exec('git config user.email "test@test.com" && git config user.name "Test"', forkPath);
    fs.writeFileSync(path.join(forkPath, 'x.ts'), 'const side = "upstream content";\n');
    exec('git add -A && git commit -m "initial"', forkPath);

    originalPath = getEnv('PATH');
    vi.stubEnv('PATH', `${binDir}:${originalPath ?? ''}`);
    vi.stubEnv('OPEN_ARGS_FILE', argsFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // openDiffInBrowser writes pages keyed by the (random) fixture repo name.
    fs.rmSync(path.join(os.tmpdir(), `cella-diff-${path.basename(forkPath)}`), { recursive: true, force: true });
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('gitDiffFile', () => {
    it('labels the sides cella/ vs dstPrefix/ when a prefix is given', () => {
      fs.writeFileSync(path.join(forkPath, 'x.ts'), 'const side = "fork content";\n');
      const patch = gitDiffFile(forkPath, 'HEAD', 'x.ts', { dstPrefix: 'myfork' }).toString();

      expect(patch).toContain('--- cella/x.ts');
      expect(patch).toContain('+++ myfork/x.ts');
    });

    it('keeps standard a/ b/ prefixes when no prefix is given (renderer input)', () => {
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
      const html = await renderDiffPage(makePatch(), { filePath: 'x.ts', srcLabel: 'cella', dstLabel: 'myfork' });

      expect(html).toContain('<!doctype html>');
      // Syntax highlighting splits lines into token spans; compare visible text.
      // Tags are stripped repeatedly until a fixed point so nested/partial
      // brackets can't survive a single pass (CodeQL js/incomplete-multi-character-sanitization).
      let text = html;
      let previous: string;
      do {
        previous = text;
        text = text.replace(/<[^>]*>/g, '');
      } while (text !== previous);
      expect(text).toContain('upstream content');
      expect(text).toContain('fork content');
      // Self-contained: styles inline, no external requests.
      expect(html).toContain('<style');
      expect(html).not.toContain('src="http');
      // The fragment must live in declarative shadow DOM: the library's palette
      // (red/green line backgrounds) is defined on :host, which matches nothing
      // outside a shadow root.
      expect(html).toContain('shadowrootmode="open"');
      // Both side labels appear in the header.
      expect(html).toContain('cella');
      expect(html).toContain('myfork');
    });

    it('escapes HTML in the file path and labels', async () => {
      const html = await renderDiffPage(makePatch(), {
        filePath: 'x.ts',
        srcLabel: '<script>alert(1)</script>',
        dstLabel: 'fork "quoted"',
        note: 'a & b',
      });

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('a &amp; b');
    });
  });

  describe('openDiffInBrowser', () => {
    it('writes the page to a stable temp path and opens it', async () => {
      const pagePath = await openDiffInBrowser(
        makePatch(),
        { filePath: 'x.ts', srcLabel: 'cella', dstLabel: 'myfork' },
        forkPath,
      );

      expect(pagePath).toBe(path.join(os.tmpdir(), `cella-diff-${path.basename(forkPath)}`, 'x.ts.html'));
      expect(fs.readFileSync(pagePath, 'utf-8')).toContain('<!doctype html>');

      const recorded = fs.readFileSync(argsFile, 'utf-8');
      expect(recorded).toContain(pagePath);
    });

    it('slugifies nested file paths into a flat file name', async () => {
      fs.mkdirSync(path.join(forkPath, 'src/utils'), { recursive: true });
      fs.writeFileSync(path.join(forkPath, 'src/utils/y.ts'), 'let y = 1;\n');
      exec('git add -A && git commit -m "add y"', forkPath);
      fs.writeFileSync(path.join(forkPath, 'src/utils/y.ts'), 'let y = 2;\n');
      const patch = gitDiffFile(forkPath, 'HEAD', 'src/utils/y.ts').toString();

      const pagePath = await openDiffInBrowser(
        patch,
        { filePath: 'src/utils/y.ts', srcLabel: 'cella', dstLabel: 'myfork' },
        forkPath,
      );

      expect(path.basename(pagePath)).toBe('src-utils-y.ts.html');
    });
  });
});
