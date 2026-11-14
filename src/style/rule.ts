import { extname } from 'node:path';
import { ts } from 'ts-morph';
import { isGeneratedFile } from '../utils/repo-files';
import type { BranchChanges } from './branch';
import type { TailwindContext } from './tailwind-class-rules';

/** One style finding. */
export interface Finding {
  file: string;
  /** 1-based, as is `column`; absent when the finding is about the path itself. */
  line?: number;
  column?: number;
  rule: string;
  /** The matched text, printed in quotes before the message; absent when the finding names no single term. */
  term?: string;
  message: string;
}

/** What a run shares with every rule: the repository and what the rules read across files. */
export interface StyleRun {
  /** Absolute path of the repository. */
  root: string;
  /** Every file of the repository, also in a run limited to a few paths. */
  files: string[];
  /** The zustand stores the frontend creates. */
  stores: Set<string>;
  /** Absent in a repository without a frontend stylesheet that imports Tailwind. */
  tailwind?: TailwindContext;
  /** Set in a full run of the template that has a merge base with `origin/main`. */
  branch?: BranchChanges;
  /** The `ignored` and `pinned` entries of the CLI config, without the template's own `owner: 'app'` modules. */
  owned: string[];
}

/** One style rule: an id, the files it reads, its check of one, and whether it reports on changed lines only. */
export interface Rule {
  /** Printed in brackets on each finding, and the key of its exemptions. */
  id: string;
  /** Whether the rule reads `file`, a repo-relative path. */
  reads: (file: string) => boolean;
  check: (file: string, source: string, run: StyleRun) => Finding[];
  /** Reads each path the branch changed, deleted ones included, with no source, in place of the repository's files. */
  branch?: true;
  /** Reports only on lines the branch added or changed since its merge base with `origin/main`, uncommitted edits included. */
  changedLines?: true;
}

/** Whether `file` is the path `entry` or inside it; `entry` may end in `/`. */
export function isUnder(file: string, entry: string): boolean {
  return file === entry || file.startsWith(entry.endsWith('/') ? entry : `${entry}/`);
}

/** App sources under frontend/src, outside generated files, content, stories and tests: the files the frontend convention rules read. */
export function isFrontendSource(file: string): boolean {
  return (
    /^frontend\/src\/.*\.tsx?$/.test(file) &&
    !isGeneratedFile(file) &&
    !file.includes('/content/') &&
    !file.includes('/stories/') &&
    !/\.(?:stories|test)\.tsx?$/.test(file)
  );
}

/** `text` with every character but a line break turned into a space, so offsets and line numbers into it still hold. */
export function blankOut(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** 1-based line and column of `offset`, counting `\n` line breaks only. */
export function lineColumn(source: string, offset: number): { line: number; column: number } {
  const lines = source.slice(0, offset).split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

let lastParsed: ts.SourceFile | undefined;

/** The TypeScript parse of a script file; the rules of one file share it. */
export function parseSource(file: string, source: string): ts.SourceFile {
  if (lastParsed?.fileName === file && lastParsed.text === source) return lastParsed;
  const kind = ['.tsx', '.jsx'].includes(extname(file)) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  lastParsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  return lastParsed;
}

/** `file:line:column [rule] "term": message`; a finding about the path itself prints the path alone. */
export function formatFinding({ file, line, column, rule, term, message }: Finding): string {
  const location = line === undefined ? file : `${file}:${line}:${column}`;
  return `${location} [${rule}] ${term === undefined ? '' : `"${term}": `}${message}`;
}
