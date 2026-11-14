import { alignmentId, alignmentsDir, bodyLines, caughtBy, isCodemodFile, splitList } from '../upstream/alignments';
import type { BranchChanges } from './branch';
import { type Finding, isUnder, type Rule } from './rule';

const alignmentsPrefix = `${alignmentsDir}/`;

/** What checking one alignment README finds: the codemod's default scan roots it names and every shape problem. */
interface ReadmeCheck {
  roots: string[];
  errors: string[];
}

const requiredBooleanKeys = ['breaking', 'clientCacheBump'];
const booleanKeys = [...requiredBooleanKeys, 'generate'];
/** Comma-separated values: the terms `pnpm cella align` greps for, and the codemod's roots. */
const listKeys = ['grep', 'roots'];

/** Checks an alignment README: its frontmatter, title and summary paragraph, and the `roots` it names. */
export function checkAlignmentReadme(source: string): ReadmeCheck {
  const errors: string[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (close === -1) errors.push('must open with a `---` frontmatter block');
  const frontmatter = new Map<string, string>();
  for (const line of lines.slice(1, Math.max(close, 1))) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(`frontmatter line is not \`key: value\`: ${line}`);
      continue;
    }
    const [, key, value] = match;
    frontmatter.set(key, value);
    if (booleanKeys.includes(key)) {
      if (value !== 'true' && value !== 'false') errors.push(`${key} must be true or false`);
    } else if (key === 'caughtBy') {
      if (!caughtBy.some((caughtBy) => caughtBy === value))
        errors.push(`caughtBy must be one of ${caughtBy.join(', ')}`);
    } else if (!listKeys.includes(key)) errors.push(`unknown frontmatter key: ${key}`);
  }
  for (const key of requiredBooleanKeys)
    if (close !== -1 && !frontmatter.has(key)) errors.push(`frontmatter is missing ${key}`);
  if (frontmatter.get('breaking') === 'true' && !frontmatter.has('caughtBy'))
    errors.push('a breaking alignment says how an app finds its leftovers: caughtBy');

  // Body: the title, then the summary paragraph. Blank lines and HTML comments in between are skipped.
  const body = bodyLines(lines.slice(close + 1)).join('\n');
  const blocks = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!/^# .+$/.test(blocks[0] ?? '')) errors.push('the first line after the frontmatter must be the `# ` title');
  const summary = blocks[1] ?? '';
  if (!summary || /^(#|>|[-*|]|```|\d+\.)/.test(summary))
    errors.push('the title must be followed by a one-paragraph summary');
  return { roots: splitList(frontmatter.get('roots')), errors };
}

/**
 * The shape `pnpm cella align` reads in an alignment folder: its name and README on the folder's first file, the README's
 * shape and `roots` exactly beside a codemod on the README.
 */
export const alignmentRule: Rule = {
  id: 'alignment',
  reads: (file) => file.startsWith(alignmentsPrefix) && file.slice(alignmentsPrefix.length).includes('/'),
  check: (file, source, { files }) => {
    const [folder, ...rest] = file.slice(alignmentsPrefix.length).split('/');
    const folderPath = `${alignmentsPrefix}${folder}`;
    const names = files
      .filter((other) => other.startsWith(`${folderPath}/`))
      .map((other) => other.slice(folderPath.length + 1));
    const findings: Finding[] = [];
    const finding = (path: string, message: string, line?: number) =>
      findings.push({ file: path, rule: 'alignment', message, ...(line === undefined ? {} : { line, column: 1 }) });
    if (names[0] === rest.join('/')) {
      if (!alignmentId.test(folder)) finding(folderPath, 'alignment folders are named <YYYYMMDDThhmm>-<slug>');
      if (!names.includes('README.md')) finding(folderPath, 'alignment folder has no README.md');
    }
    if (rest.join('/') !== 'README.md') return findings;
    const { roots, errors } = checkAlignmentReadme(source);
    for (const error of errors) finding(file, error, 1);
    const codemods = names.filter((name) => !name.includes('/') && isCodemodFile(name));
    if (codemods.length > 1) finding(file, `one codemod per alignment, found ${codemods.join(', ')}`, 1);
    if (roots.length > 0 && codemods.length === 0) finding(file, 'roots is only for an alignment with a codemod', 1);
    if (roots.length === 0 && codemods.length > 0)
      finding(file, 'a codemod needs roots: the folders `pnpm cella align run` scans by default', 1);
    return findings;
  },
};

/** Whether the branch adds an alignment README, or a commit message waives one with `Alignment: none, <reason>`. */
function meetsAlignment({ added, messages }: BranchChanges): boolean {
  const addsAlignment = added.some((file) => {
    const [folder, name, ...rest] = file.slice(alignmentsPrefix.length).split('/');
    return file.startsWith(alignmentsPrefix) && alignmentId.test(folder) && name === 'README.md' && rest.length === 0;
  });
  return addsAlignment || /^Alignment: none\b.*\w/m.test(messages);
}

/**
 * A changed app-owned path template code reads from (a pinned file, `logo-art.tsx`, `backend/drizzle`) on a branch that
 * adds no alignment. Such a change never reaches an app's copy, so the app's template code breaks until someone tells
 * it what to add.
 */
export const owedAlignmentRule: Rule = {
  id: 'owed-alignment',
  branch: true,
  // A Markdown file inside an owned folder is read by people, never by template code
  reads: (file) => !file.endsWith('.md'),
  check: (file, _source, { branch, owned }) =>
    branch && owned.some((entry) => isUnder(file, entry)) && !meetsAlignment(branch)
      ? [
          {
            file,
            rule: 'owed-alignment',
            message:
              'apps own this path and their template code reads from it: add an alignment under cella/alignments/ in this branch, or put `Alignment: none, <reason>` in a commit message',
          },
        ]
      : [],
};
