import { extname } from 'node:path';
import { isProseExempt, proseRules, ruleFindings } from './prose-rules';
import { blankOut, type Finding, lineColumn } from './repo';

const docExtensions = new Set(['.md', '.mdx']);
const docRules = proseRules.filter((rule) => rule.docs);

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

/** The prose view: inline code, fenced code and link targets blanked to spaces, so positions hold. */
function maskMarkdownCode(source: string): string {
  return outsideFences(source, (line) =>
    line.replace(/\]\([^)]+\)/g, (match) => `]${blankOut(match.slice(1))}`).replace(/`[^`\n]*`/g, blankOut),
  );
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

/** Folders the paragraph rule skips: alignments address an upgrade's maintainer once, skills address an agent. */
const paragraphExempt = /^cella\/(?:alignments|skills)\//;

/** A raw line that is no prose: indented, a heading, a table row, a list item, a quote, HTML or JSX, an MDX statement, a frontmatter or admonition fence. */
const notProse = /^(?:\s|#|\||[-*+]\s|\d+\.\s|>|<|\{|import\s|export\s|---|:::)/;

/**
 * A prose paragraph of more than `maxParagraphWords` words, reported at its first line. Words are counted on the
 * prose view, so inline code and link targets count for nothing; a fenced block is blank there and ends a paragraph.
 */
function longParagraphFindings(file: string, source: string, prose: string): Finding[] {
  if (paragraphExempt.test(file)) return [];
  const rawLines = source.split('\n');
  const proseLines = prose.split('\n');
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

/** Rule findings in the prose of one Markdown or MDX file, inline code in its link labels, and its long paragraphs. */
export function docFindings(file: string, source: string): Finding[] {
  if (!docExtensions.has(extname(file).toLowerCase()) || isProseExempt(file, 'doc')) return [];
  const prose = maskMarkdownCode(source);
  return [
    ...docRules.flatMap((rule) => ruleFindings(rule, file, prose, (index) => lineColumn(prose, index))),
    ...codeLinkFindings(file, source),
    ...longParagraphFindings(file, source, prose),
  ];
}
