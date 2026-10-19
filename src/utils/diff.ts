/**
 * Diff helpers: a single-file `git diff`, and diffs rendered as a self-contained HTML page that
 * opens in the default browser. Used by the contributions service and the review page.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { MAX_BUFFER } from './git';

/**
 * Run `git diff` for a single file over `range` (`a..b`, or one ref to diff against the working
 * tree). Returns the raw diff with standard a/ b/ prefixes, which the HTML renderer's patch
 * parser requires; empty when the file is identical.
 */
export function gitDiffFile(cwd: string, range: string, filePath: string): Buffer {
  try {
    return execFileSync('git', ['diff', '--no-color', range, '--', filePath], { cwd, maxBuffer: MAX_BUFFER });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(stderr || `failed to diff ${filePath}`);
  }
}

/** One file on a diff page: its path and its unified diff, with standard a/ b/ prefixes. */
export interface DiffPageFile {
  path: string;
  patch: string;
}

/** A group of files on a diff page, under an optional title and a line saying what the diffs show. */
export interface DiffPageSection {
  title?: string;
  hint?: string;
  files: DiffPageFile[];
  /** Files left off the page, one line each (e.g. a `git diff` to run instead) */
  omitted?: string[];
}

/** The page header: a title, plus dim context after it. */
interface DiffPageMeta {
  title: string;
  /** Extra context shown after the title (e.g. 'cella ← → myfork') */
  note?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render diffs as a complete, self-contained HTML document: one block per file, grouped in
 * sections, with a section index at the top when there is more than one.
 *
 * Highlighting and diff layout come from `@pierre/diffs` (Shiki-based), rendered server-side to
 * static HTML: no scripts, no external requests, adapts to the viewer's light/dark preference.
 * Patches must use standard a/ b/ prefixes, as `gitDiffFile` returns them.
 */
export async function renderDiffPage(sections: DiffPageSection[], meta: DiffPageMeta): Promise<string> {
  // Lazy import: the CLI is a short-lived process and most invocations never
  // render a diff, so startup shouldn't pay Shiki's module-load cost.
  const { preloadPatchDiff } = await import('@pierre/diffs/ssr');

  const renderFile = async (file: DiffPageFile) => {
    const { prerenderedHTML } = await preloadPatchDiff({
      patch: file.patch,
      options: {
        diffStyle: 'split',
        themeType: 'system',
        lineDiffType: 'word-alt',
        hunkSeparators: 'line-info',
        overflow: 'wrap',
      },
    });
    // Declarative shadow DOM: the library's CSS targets :host, which only matches inside a
    // shadow root (its browser component renders into one).
    return `<div class="diff-shell"><template shadowrootmode="open">\n${prerenderedHTML}\n</template></div>`;
  };

  const blocks: string[] = [];
  for (const [index, section] of sections.entries()) {
    const files: string[] = [];
    for (const file of section.files) files.push(await renderFile(file));
    const count = section.files.length + (section.omitted?.length ?? 0);
    const title = section.title
      ? `<h2>${escapeHtml(section.title)} <span class="count">· ${count} ${count === 1 ? 'file' : 'files'}</span></h2>`
      : '';
    const hint = section.hint ? `<p class="hint">${escapeHtml(section.hint)}</p>` : '';
    const omitted = section.omitted?.length
      ? `<ul class="omitted">${section.omitted.map((line) => `<li><code>${escapeHtml(line)}</code></li>`).join('')}</ul>`
      : '';
    blocks.push(`<section id="section-${index + 1}">${title}${hint}${files.join('\n')}${omitted}</section>`);
  }

  const titled = sections.filter((section) => section.title);
  const index =
    titled.length > 1
      ? `<nav><ol>${sections
          .map((section, i) =>
            section.title
              ? `<li><a href="#section-${i + 1}">${escapeHtml(section.title)}</a> <span class="count">· ${
                  section.files.length + (section.omitted?.length ?? 0)
                }</span></li>`
              : '',
          )
          .join('')}</ol></nav>`
      : '';
  const note = meta.note ? `<span class="note">${escapeHtml(meta.note)}</span>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
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
    position: sticky; top: 0; z-index: 1;
    background: inherit;
  }
  header .brand { font-weight: 600; color: light-dark(#0891b2, #22d3ee); }
  header code { font-family: ui-monospace, monospace; font-size: 0.9rem; }
  header .note { margin-left: auto; font-size: 0.8rem; opacity: 0.7; }
  main { max-width: 1400px; margin: 1rem auto; padding: 0 1rem 2rem; }
  nav ol { margin: 0 0 1.5rem; padding-left: 1.25rem; line-height: 1.7; }
  nav a { color: inherit; }
  section { scroll-margin-top: 4rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 0.25rem; }
  .count { font-weight: normal; opacity: 0.6; }
  .hint { margin: 0 0 1rem; font-size: 0.9rem; opacity: 0.75; max-width: 80ch; }
  .diff-shell {
    border: 1px solid light-dark(#e2e2e2, #2a2a2a);
    border-radius: 8px; overflow: hidden;
    background: light-dark(#fff, #161616);
    margin-bottom: 1rem;
  }
  .omitted { font-size: 0.85rem; opacity: 0.8; }
  .omitted code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<header>
  <span class="brand">⧈ cella diff</span>
  <code>${escapeHtml(meta.title)}</code>
  ${note}
</header>
<main>
${index}
${blocks.join('\n')}
</main>
</body>
</html>`;
}

/**
 * Render a diff page and write it to `<git dir>/cella-diff/<name>.html`. Inside the git dir the
 * page never reaches a commit and goes with the checkout; the path is stable per name, so a
 * rerun overwrites it and a browser refresh shows the latest render.
 *
 * @returns Absolute path of the written HTML file.
 */
export async function writeDiffPage(
  sections: DiffPageSection[],
  meta: DiffPageMeta,
  repoPath: string,
  name: string,
): Promise<string> {
  const html = await renderDiffPage(sections, meta);
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoPath, encoding: 'utf8' }).trim();
  const dir = join(gitDir, 'cella-diff');
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${name.replace(/[^\w.-]+/g, '-')}.html`);
  writeFileSync(outPath, html);
  return outPath;
}

/**
 * Open a file or URL with `open` (macOS) or `xdg-open`. Best-effort: a missing or failing opener
 * is not fatal, it returns false (e.g. a headless environment without a browser).
 */
export function openInBrowser(target: string): boolean {
  try {
    execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
