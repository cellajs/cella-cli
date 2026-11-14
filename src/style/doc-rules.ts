import { extname } from 'node:path';
import { blankOut, type Finding, lineColumn, type Rule } from './rule';

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

/** The rules of Markdown and MDX files beside the wording rules: inline code in a link label, and a long paragraph. */
export const docRules: Rule[] = [
  { id: 'code-in-link', reads: isDoc, check: codeLinkFindings },
  { id: 'long-paragraph', reads: isDoc, check: longParagraphFindings },
];
