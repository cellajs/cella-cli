/**
 * Diff helpers for sync CLI v2.
 *
 * Shared logic for producing a single-file `git diff` and for rendering a diff
 * as a self-contained HTML page that opens in the default browser. Used by the
 * analyze and contributions services.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

/**
 * Run `git diff` for a single file.
 *
 * With `dstPrefix`, the sides are labeled `cella/<path>` vs `<dstPrefix>/<path>`
 * instead of opaque a/ and b/ — used for the `--diff` stdout mode where the
 * labels carry meaning. Without it, standard a/ b/ prefixes are kept, which the
 * HTML renderer's patch parser requires.
 *
 * @param cwd - Repo to run the diff in
 * @param range - Ref range (e.g. 'upstreamRef..HEAD'), or a single ref to diff
 *   that ref against the working tree
 * @param filePath - File to diff
 * @returns Raw diff output (empty when the file is identical)
 */
export function gitDiffFile(
  cwd: string,
  range: string,
  filePath: string,
  options: { dstPrefix?: string } = {},
): Buffer {
  const args = ['diff', '--no-color'];
  if (options.dstPrefix) args.push('--src-prefix=cella/', `--dst-prefix=${options.dstPrefix}/`);
  args.push(range, '--', filePath);

  const result = spawnSync('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(stderr || `failed to diff ${filePath}`);
  }
  return result.stdout;
}

/** Labels shown in the header of a rendered diff page. */
export interface DiffPageMeta {
  /** File path shown in the page header and title */
  filePath: string;
  /** Label for the upstream side (e.g. 'cella') */
  srcLabel: string;
  /** Label for the local side (e.g. the fork name) */
  dstLabel: string;
  /** Extra context shown after the labels (e.g. 'includes uncommitted changes') */
  note?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a unified diff as a complete, self-contained HTML document.
 *
 * Highlighting and diff layout come from `@pierre/diffs` (Shiki-based), rendered
 * server-side to static HTML: no scripts, no external requests, adapts to the
 * viewer's light/dark preference. The patch must use standard a/ b/ prefixes
 * (call `gitDiffFile` without `dstPrefix`); side labels belong in `meta` instead.
 */
export async function renderDiffPage(patch: string, meta: DiffPageMeta): Promise<string> {
  // Lazy import: the CLI is a short-lived process and most invocations never
  // render a diff, so startup shouldn't pay Shiki's module-load cost.
  const { preloadPatchDiff } = await import('@pierre/diffs/ssr');

  const { prerenderedHTML } = await preloadPatchDiff({
    patch,
    options: {
      diffStyle: 'split',
      themeType: 'system',
      lineDiffType: 'word-alt',
      hunkSeparators: 'line-info',
      overflow: 'wrap',
      disableFileHeader: true,
    },
  });

  const title = `${escapeHtml(meta.filePath)} · ${escapeHtml(meta.srcLabel)} vs ${escapeHtml(meta.dstLabel)}`;
  const note = meta.note ? `<span class="note">· ${escapeHtml(meta.note)}</span>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: light-dark(#fafafa, #111);
    color: light-dark(#111, #eee);
  }
  header {
    display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap;
    padding: 0.9rem 1.25rem;
    border-bottom: 1px solid light-dark(#e2e2e2, #2a2a2a);
    position: sticky; top: 0;
    background: inherit;
  }
  header .brand { font-weight: 600; color: light-dark(#0891b2, #22d3ee); }
  header code { font-family: ui-monospace, monospace; font-size: 0.9rem; }
  header .sides { margin-left: auto; font-size: 0.8rem; opacity: 0.7; }
  main { max-width: 1400px; margin: 1rem auto; padding: 0 1rem 2rem; }
  .diff-shell {
    border: 1px solid light-dark(#e2e2e2, #2a2a2a);
    border-radius: 8px; overflow: hidden;
    background: light-dark(#fff, #161616);
  }
</style>
</head>
<body>
<header>
  <span class="brand">⧈ cella diff</span>
  <code>${escapeHtml(meta.filePath)}</code>
  <span class="sides">${escapeHtml(meta.srcLabel)} ← → ${escapeHtml(meta.dstLabel)} ${note}</span>
</header>
<main>
  <!-- Declarative shadow DOM: the library's CSS targets :host, which only
       matches inside a shadow root (its browser component renders into one). -->
  <div class="diff-shell">
    <template shadowrootmode="open">
${prerenderedHTML}
    </template>
  </div>
</main>
</body>
</html>`;
}

/** Open a file or URL with the platform's default handler. */
function openWithDefaultApp(target: string): void {
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', target], { stdio: 'ignore' });
    return;
  }
  spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { stdio: 'ignore' });
}

/**
 * Render a diff page, write it to a stable temp path, and open it in the browser.
 *
 * The output path is keyed by repo name and file path and overwritten on each
 * view, so repeat views don't litter tmp and a browser refresh shows the latest
 * render.
 *
 * @returns Absolute path of the written HTML file.
 */
export async function openDiffInBrowser(patch: string, meta: DiffPageMeta, repoPath: string): Promise<string> {
  const html = await renderDiffPage(patch, meta);

  const dir = join(tmpdir(), `cella-diff-${basename(repoPath)}`);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${meta.filePath.replace(/[^\w.-]+/g, '-')}.html`);

  writeFileSync(outPath, html);
  openWithDefaultApp(outPath);
  return outPath;
}
