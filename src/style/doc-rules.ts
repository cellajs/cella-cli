import { readFileSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { blankOut, type Finding, lineColumn, type Rule, type StyleRun } from './rule';

const docExtensions = new Set(['.md', '.mdx']);

/** Markdown and MDX files, outside the changelogs release-please writes from commit messages. */
export function isDoc(file: string): boolean {
  return docExtensions.has(extname(file).toLowerCase()) && !file.endsWith('CHANGELOG.md');
}

/** Each line outside fenced code through `mask`; fences and fenced code blanked to spaces, so positions hold. */
function outsideFences(source: string, mask: (line: string) => string): string {
  let inFence = false;
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
      else if (!inFence) return mask(line);
      return blankOut(line);
    })
    .join('\n');
}

let lastProse: { source: string; prose: string } | undefined;

/** The prose view: inline code, fenced code and link targets blanked to spaces, so positions hold. The rules of one file share it. */
export function markdownProse(source: string): string {
  if (lastProse?.source !== source) {
    const prose = outsideFences(source, (line) =>
      line.replace(/\]\([^)]+\)/g, (match) => `]${blankOut(match.slice(1))}`).replace(/`[^`\n]*`/g, blankOut),
    );
    lastProse = { source, prose };
  }
  return lastProse.prose;
}

/** Inline code in a link label: the docs draw code as a chip that hides the link underline. Double-backtick spans show the pattern as an example. */
function codeLinkFindings(file: string, source: string): Finding[] {
  const text = outsideFences(source, (line) => line.replace(/``.+?``/g, blankOut));
  return [...text.matchAll(/(?<!!)\[[^[\]\n]*`[^`[\]\n]+`[^[\]\n]*\](?=[([])/g)].map((match) => ({
    file,
    ...lineColumn(text, match.index),
    rule: 'code-in-link',
    term: match[0],
    message: 'drop the backticks inside the link label: the code chip hides the link underline',
  }));
}

/** The most words a docs reader scans as one idea; a longer paragraph holds several ideas or a list. */
const maxParagraphWords = 80;

/** A raw line that is no prose: indented, a heading, a table row, a list item, a quote, HTML or JSX, an MDX statement, a frontmatter or admonition fence. */
const notProse = /^(?:\s|#|\||[-*+]\s|\d+\.\s|>|<|\{|import\s|export\s|---|:::)/;

/**
 * A prose paragraph of more than `maxParagraphWords` words, reported at its first line. Words are counted on the
 * prose view, so inline code and link targets count for nothing; a fenced block is blank there and ends a paragraph.
 */
function longParagraphFindings(file: string, source: string): Finding[] {
  const rawLines = source.split('\n');
  const proseLines = markdownProse(source).split('\n');
  const findings: Finding[] = [];
  let start = -1;
  let words = 0;
  const close = () => {
    if (start >= 0 && words > maxParagraphWords) {
      findings.push({
        file,
        line: start,
        column: 1,
        rule: 'long-paragraph',
        term: `${words} words`,
        message: `split the paragraph at its idea boundaries or list its facts: a reader scans one idea per paragraph, at most ${maxParagraphWords} words`,
      });
    }
    start = -1;
    words = 0;
  };
  for (const [index, raw] of rawLines.entries()) {
    if (proseLines[index].trim() === '' || notProse.test(raw)) {
      close();
      continue;
    }
    if (start < 0) start = index + 1;
    words += proseLines[index].split(/\s+/).filter(Boolean).length;
  }
  close();
  return findings;
}

/** The most characters a `##` heading of a docs page renders. */
const maxHeadingChars = 25;

/** Where the frontend keeps its docs pages. */
const docsPagesFolder = 'frontend/src/content/docs/';

const docsFilesOfRun = new WeakMap<StyleRun, Set<string>>();

/** The docs pages of the repository and the Markdown files they import, which a reader sees as part of the page. One read serves a run. */
function docsFiles(run: StyleRun): Set<string> {
  let files = docsFilesOfRun.get(run);
  if (!files) {
    const pages = run.files.filter((file) => file.startsWith(docsPagesFolder) && isDoc(file));
    files = new Set(pages);
    for (const page of pages) {
      const source = readFileSync(join(run.root, page), 'utf8');
      for (const [, target] of source.matchAll(/^import\s+\w+\s+from\s+["']([^"']+\.mdx?)["']/gm)) {
        files.add(posix.normalize(posix.join(posix.dirname(page), target)));
      }
    }
    docsFilesOfRun.set(run, files);
  }
  return files;
}

/** A heading as a page renders it: a link by its label, code and bold without their marks. */
function renderedHeading(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
}

/** A `##` heading that renders more than `maxHeadingChars` characters, on a docs page or in a Markdown file one imports. */
function longHeadingFindings(file: string, source: string, run: StyleRun): Finding[] {
  if (!docsFiles(run).has(file)) return [];
  return outsideFences(source, (line) => line)
    .split('\n')
    .flatMap((line, index) => {
      const heading = /^## (.+)$/.exec(line)?.[1];
      const length = heading ? [...renderedHeading(heading)].length : 0;
      if (length <= maxHeadingChars) return [];
      return [
        {
          file,
          line: index + 1,
          column: 1,
          rule: 'long-heading',
          term: `${length} characters`,
          message: `shorten the heading: a section heading of a docs page renders at most ${maxHeadingChars} characters`,
        },
      ];
    });
}

/** The rules of Markdown and MDX files beside the wording rules: inline code in a link label, a long paragraph, a long docs heading. */
export const docRules: Rule[] = [
  { id: 'code-in-link', reads: isDoc, check: codeLinkFindings },
  { id: 'long-paragraph', reads: isDoc, check: longParagraphFindings },
  { id: 'long-heading', reads: isDoc, check: longHeadingFindings },
];
