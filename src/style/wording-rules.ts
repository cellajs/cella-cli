import { fileComments, isCommentSource } from './comments';
import { isDoc, markdownProse } from './doc-rules';
import { blankOut, type Finding, lineColumn, type Rule } from './rule';

/** A wording rule, read in every source comment. */
interface WordingRule {
  id: string;
  pattern: RegExp;
  /** The advice printed after the matched term. */
  message: string;
  /** Also read in Markdown and MDX prose. */
  docs?: boolean;
  /** Read in the whole text of a source file, strings and JSON values included, not only in its comments. */
  text?: boolean;
  changedLines?: true;
  /** A match inside a sentence of at most this many words passes: a short pair states one idea. */
  maxSentenceWords?: number;
}

/** The wording rules; each gets its line in the README. */
const wordingTable: WordingRule[] = [
  {
    id: 'em-dash',
    pattern: /\u2014/,
    message: 'split the sentence, use a colon, or drop the clause',
    docs: true,
    text: true,
  },
  {
    id: 'contrast-phrase',
    pattern: /\b(?:instead|rather than|as opposed to)\b/i,
    message: 'state the current behavior or local constraint directly',
  },
  {
    id: 'concrete-language',
    pattern: /\binvariants?\b/i,
    message: 'name the precise rule, constraint, guarantee, requirement, contract, precondition, or assumption',
    docs: true,
  },
  {
    id: 'change-history',
    pattern: /\b(?:previously|formerly|used to|originally)\b/i,
    message: 'move evolution history to the commit or an alignment',
  },
  {
    id: 'review-conversation',
    pattern: /\b(?:maybe|perhaps|we (?:should|could|might)|(?:was|were) considered)\b/i,
    message: 'resolve the question or track it outside the source comment',
  },
  {
    id: 'load-bearing',
    pattern: /\bload(?:-| )bearing\b/i,
    docs: true,
    message: 'name the dependency, requirement, or failure consequence directly',
  },
  {
    id: 'authoritative',
    pattern: /\bauthoritative(?:ly)?\b/i,
    docs: true,
    message: 'say who decides or which value counts: the backend decides, the stored row, the exact count',
  },
  {
    id: 'consequence-tail',
    pattern: /,\s+so\s(?!\s*that\b)/,
    message:
      'make the reason and its consequence two sentences, the one the reader needs first going first, or drop the half that restates the code or the mechanism',
    docs: true,
    changedLines: true,
    maxSentenceWords: 15,
  },
];

/** `text` with the comment markers that open a line (`//`, `/*`, `*`, `#`, `--`) or close a block blanked. */
function blankCommentMarkers(text: string): string {
  return text.replace(/^[\t ]*(?:\/\/+|\/\*+|\*+\/?|#+|--+)|\*\/[\t ]*$/gm, blankOut);
}

/** Words in the sentence around `index`, across wrapped lines: from the last sentence end or block start to the next. */
function sentenceWords(prose: string, index: number): number {
  // A line break opens a block before a blank line, a list item, a table row, a heading, a quote or a JSDoc tag
  const block = String.raw`\n(?=[\t ]*(?:\n|[-+*>#|@]|\d+[.)]\s))`;
  const last = [...prose.slice(0, index).matchAll(new RegExp(String.raw`[.!?;:](?=\s)|${block}`, 'g'))].at(-1);
  const end = prose.slice(index).search(new RegExp(String.raw`[.!?](?:\s|$)|${block}`));
  return prose
    .slice(last ? last.index + 1 : 0, end === -1 ? undefined : index + end)
    .split(/\s+/)
    .filter(Boolean).length;
}

/** A finding for every match of `rule` in `text`; `locate` maps an index in `text` to its line and column in `file`. */
function matchFindings(rule: WordingRule, file: string, text: string, locate: (index: number) => { line: number; column: number }): Finding[] {
  const prose = /\.mdx?$/i.test(file) ? text : blankCommentMarkers(text);
  if (!rule.pattern.test(prose)) return [];
  const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
  const matches = [...prose.matchAll(pattern)].filter(
    (match) => rule.maxSentenceWords === undefined || sentenceWords(prose, match.index) > rule.maxSentenceWords,
  );
  return matches.map((match) => ({
    file,
    ...locate(match.index),
    rule: rule.id,
    term: match[0].replace(/\s+/g, ' '),
    message: rule.message,
  }));
}

/** The wording rules: in Markdown, the prose outside code; in source, the comments, or the whole text with `text`. */
export const wordingRules: Rule[] = wordingTable.map((rule) => ({
  id: rule.id,
  reads: (file) => isCommentSource(file) || (rule.docs === true && isDoc(file)),
  changedLines: rule.changedLines,
  check: (file, source) => {
    if (isDoc(file)) {
      const prose = markdownProse(source);
      return matchFindings(rule, file, prose, (index) => lineColumn(prose, index));
    }
    if (rule.text) return matchFindings(rule, file, source, (index) => lineColumn(source, index));
    return fileComments(file, source).flatMap((comment) =>
      matchFindings(rule, file, comment.text, (index) => lineColumn(source, comment.offset + index)),
    );
  },
}));
