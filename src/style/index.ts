import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../command';
import { resolveAppModuleFolders } from '../config/app-modules';
import { loadConfig } from '../config/load';
import { git } from '../utils/git';
import { listRepoFiles } from '../utils/repo-files';
import { alignmentRule, owedAlignmentRule } from './alignment-rules';
import { branchChanges, changedLines, onChangedLines } from './branch';
import { detachedCommentRule } from './comment-rules';
import { docRules } from './doc-rules';
import { loadExceptions, type StyleExceptions } from './exceptions';
import { frontendRules, frontendStores } from './frontend-rules';
import { type Finding, formatFinding, isUnder, type Rule, type StyleRun } from './rule';
import { stampRules } from './stamp-rules';
import { tailwindClassRule, tailwindContext } from './tailwind-class-rules';
import { textColorRule } from './text-color-rules';
import { tokenContrastRule } from './token-contrast-rules';
import { productNameRule, sourceControlTermRule } from './vocabulary-rules';
import { wordingRules } from './wording-rules';

interface StyleOptions {
  /** Repo-relative paths whose files the in-file rules read; none reads every file. */
  paths: string[];
}

/** Every rule; findings on one position of a file print in this order. */
export const styleRules: Rule[] = [
  owedAlignmentRule,
  alignmentRule,
  sourceControlTermRule,
  productNameRule,
  ...wordingRules,
  ...docRules,
  detachedCommentRule,
  ...frontendRules,
  ...stampRules,
  tailwindClassRule,
  textColorRule,
  tokenContrastRule,
];

/** The findings of each rule in `rules` that reads `file` and is not exempt from it, by position. */
export function checkFile(rules: Rule[], file: string, source: string, run: StyleRun, { exempt }: StyleExceptions): Finding[] {
  return rules
    .filter((rule) => rule.reads(file) && !exempt[rule.id]?.some((entry) => isUnder(file, entry)))
    .flatMap((rule) => rule.check(file, source, run))
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
}

/** Whether `file` is one of the requested roots or inside one; no roots requests every file. */
function isRequested(file: string, roots: string[]): boolean {
  return roots.length === 0 || roots.some((root) => isUnder(file, root.replace(/^\.\//, '').replace(/\/$/, '')));
}

/** The `ignored` and `pinned` entries of the CLI config; the template's own `owner: 'app'` modules hold nothing template code reads. */
async function ownedPaths(root: string): Promise<string[]> {
  const appModules = resolveAppModuleFolders(root);
  const { ignored = [], pinned = [] } = await loadConfig(root);
  return [...ignored, ...pinned].filter((entry) => !appModules.includes(entry));
}

/** Runs every rule over the repository in `root` and prints the findings; 1 when there are any. */
async function runStyle(root: string, { paths }: StyleOptions): Promise<number> {
  const exceptions = await loadExceptions(
    root,
    styleRules.map((rule) => rule.id),
  );
  const files = listRepoFiles(root);
  const base = await git(['merge-base', 'HEAD', 'origin/main'], root, { ignoreErrors: true });
  // Alignments are written where they live: an app's own changes to its own paths owe none. Every upgraded app has an
  // upgrade manifest, and an app's scaffold can hold a copy of the alignments folder, so the folder alone does not mark
  // the template.
  const owesAlignments = paths.length === 0 && files.includes('cella/alignments/_TEMPLATE.md') && !files.includes('cella/cella.manifest.json');
  const branch = owesAlignments && base ? await branchChanges(root, base) : undefined;
  const run: StyleRun = {
    root,
    files,
    stores: frontendStores(root, files),
    tailwind: await tailwindContext(root, files, exceptions.markerClasses),
    branch,
    owned: branch ? await ownedPaths(root) : [],
  };

  const findings: Finding[] = paths
    .filter((path) => !files.some((file) => isRequested(file, [path])))
    .map((path) => ({ file: path, rule: 'path-argument', message: 'no file matches this path' }));
  const branchRules = styleRules.filter((rule) => rule.branch);
  for (const file of run.branch?.changed ?? []) findings.push(...checkFile(branchRules, file, '', run, exceptions));
  const fileRules = styleRules.filter((rule) => !rule.branch);
  for (const file of files.filter((file) => isRequested(file, paths))) {
    const content = readFileSync(join(root, file));
    if (!content.includes(0)) findings.push(...checkFile(fileRules, file, content.toString('utf8'), run, exceptions));
  }

  const changedLineRules = new Set(styleRules.filter((rule) => rule.changedLines).map((rule) => rule.id));
  const ratchetFiles = new Set(findings.filter((finding) => changedLineRules.has(finding.rule)).map(({ file }) => file));
  const ratchet = base ? await changedLines(root, base, ratchetFiles) : { changed: null, untracked: new Set<string>() };
  const kept = onChangedLines(findings, changedLineRules, ratchet.changed, ratchet.untracked);

  if (!base) {
    const skipped = [`the changed-line rules (${[...changedLineRules].join(', ')})`];
    if (owesAlignments) skipped.push('the owed-alignment check');
    console.error(`[style] skipped ${skipped.join(' and ')}: HEAD has no merge base with origin/main`);
  }

  if (kept.length > 0) {
    console.info([`[style] ${kept.length} finding(s):`, ...kept.map((finding) => `  ${formatFinding(finding)}`)].join('\n'));
    return 1;
  }
  console.info('[style] OK, terminology, documentation, comments and frontend code follow the required style.');
  return 0;
}

export const styleCommand: Command<StyleOptions> = {
  name: 'style',
  group: 'gate',
  description: 'the style check: terminology, docs, comments and frontend code; exits 1 on any finding',
  jobs: [],
  operands: ['[paths...]', 'limit the files the in-file rules read to these repo-relative paths'],
  parse: ({ operands }) => ({ paths: operands }),
  run: runStyle,
};
