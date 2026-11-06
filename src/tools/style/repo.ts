import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type TypeScript from 'typescript';
import { importFromWorkspace } from '../../utils/app-facts';

/** Absolute path of the repository a run checks; every repo-relative path here resolves against it. */
export let repoRoot = '';

/** The TypeScript the app's root package installed, so the CLI ships none. */
export let ts: typeof TypeScript;

/** The node types the rules name as `ts.<Type>`: a namespace of types merges with the binding above. */
export declare namespace ts {
  type ArrowFunction = TypeScript.ArrowFunction;
  type BindingName = TypeScript.BindingName;
  type CallExpression = TypeScript.CallExpression;
  type CommentRange = TypeScript.CommentRange;
  type Expression = TypeScript.Expression;
  type FunctionExpression = TypeScript.FunctionExpression;
  type FunctionLikeDeclaration = TypeScript.FunctionLikeDeclaration;
  type Node = TypeScript.Node;
  type ObjectLiteralExpression = TypeScript.ObjectLiteralExpression;
  type PropertyName = TypeScript.PropertyName;
  type SourceFile = TypeScript.SourceFile;
  type StringLiteralLike = TypeScript.StringLiteralLike;
  type TemplateExpression = TypeScript.TemplateExpression;
  type TemplateLiteralLikeNode = TypeScript.TemplateLiteralLikeNode;
  type VariableStatement = TypeScript.VariableStatement;
}

/**
 * Points the rules at the repository in `root` and loads its TypeScript. Call it before any other export of this
 * folder: they read `repoRoot` and `ts`.
 * @throws when the root package has no `typescript` installed
 */
export async function openRepository(root: string): Promise<void> {
  ts = await importFromWorkspace<typeof TypeScript>(root, '.', 'typescript');
  repoRoot = root;
}

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

/** Repo-relative files git tracks, plus untracked ones it does not ignore, that exist on disk, in `git ls-files` order. */
export function repoFiles(): string[] {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && existsSync(join(repoRoot, file)));
}

/** Whether `file` is the path `entry` or inside it; `entry` may end in `/`. */
export function isUnder(file: string, entry: string): boolean {
  return file === entry || file.startsWith(entry.endsWith('/') ? entry : `${entry}/`);
}

/** Whether `file` is one of the requested roots or inside one; no roots requests every file. */
export function isRequested(file: string, roots: string[]): boolean {
  return roots.length === 0 || roots.some((root) => isUnder(file, root.replace(/^\.\//, '').replace(/\/$/, '')));
}

/** App sources under frontend/src, outside generated files, content, stories and tests: the files the frontend convention rules read. */
export function isFrontendSource(file: string): boolean {
  return (
    /^frontend\/src\/.*\.tsx?$/.test(file) &&
    !file.includes('.gen.') &&
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

/** `file:line:column [rule] "term": message`; a finding about the path itself prints the path alone. */
export function formatFinding({ file, line, column, rule, term, message }: Finding): string {
  const location = line === undefined ? file : `${file}:${line}:${column}`;
  return `${location} [${rule}] ${term === undefined ? '' : `"${term}": `}${message}`;
}
