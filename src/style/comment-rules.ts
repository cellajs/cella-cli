import { extname } from 'node:path';
import { ts } from 'ts-morph';
import { type Comment, fileComments, isCommentSource, scriptExtensions } from './comments';
import { type Finding, lineColumn, parseSource, type Rule } from './rule';

const placementAdvice = 'move shared context to a README or attach a concise local constraint to a declaration';

function proseLineCount(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*\/\/\/?\s?/, '')
        .replace(/^\s*\/\*\*?\s?/, '')
        .replace(/^\s*\*\/?\s?/, '')
        .replace(/\s*\*\/$/, '')
        .trim(),
    )
    .filter(Boolean).length;
}

function isRequiredHeader(text: string): boolean {
  return /\b(?:copyright|licensed under|permission is hereby granted|the software is provided)\b/i.test(text);
}

/** Whether a comment of more than three prose lines may sit directly above `statement`. */
function isDeclaration(statement: ts.Node): boolean {
  return [
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.EnumDeclaration,
    ts.SyntaxKind.ExportAssignment,
    ts.SyntaxKind.ExportDeclaration,
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.ModuleDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.VariableStatement,
  ].includes(statement.kind);
}

function hasDirectDeclarationOwner(file: string, source: string, comment: Comment): boolean {
  if (!scriptExtensions.has(extname(file))) return false;

  const sourceFile = parseSource(file, source);
  const containingStatement = sourceFile.statements.find(
    (statement) => statement.getStart(sourceFile) < comment.offset && comment.end < statement.end,
  );
  if (containingStatement) return true;

  const nextStatement = sourceFile.statements.find((statement) => statement.getStart(sourceFile) >= comment.end);
  if (!nextStatement || !isDeclaration(nextStatement)) return false;

  const gap = source.slice(comment.end, nextStatement.getStart(sourceFile));
  return /^\s*$/.test(gap) && !/\r?\n[\t ]*\r?\n/.test(gap);
}

/** A comment of more than three prose lines that documents no declaration directly below or around it. */
export const detachedCommentRule: Rule = {
  id: 'detached-long-comment',
  reads: isCommentSource,
  check: (file, source) => {
    const findings: Finding[] = [];
    for (const comment of fileComments(file, source)) {
      const lineCount = proseLineCount(comment.text);
      if (lineCount <= 3 || isRequiredHeader(comment.text) || hasDirectDeclarationOwner(file, source, comment)) continue;
      findings.push({
        file,
        ...lineColumn(source, comment.offset),
        rule: 'detached-long-comment',
        message: `${lineCount} prose lines; ${placementAdvice}`,
      });
    }
    return findings;
  },
};
