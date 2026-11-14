import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type StyleExceptions, templateExceptions } from '../../src/style/exceptions';
import { checkFile } from '../../src/style/index';
import type { Finding, Rule, StyleRun } from '../../src/style/rule';

/** This checkout: its devDependencies stand in for the TypeScript and Tailwind an app installs. */
export const cliRoot = resolve(__dirname, '../..');

/** A git repository holding `files`, whose `node_modules` (and `frontend/node_modules` with `frontend`) is this checkout's. */
export function makeRepo(files: Record<string, string>, { frontend = false } = {}): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'style-checks-'));
  for (const [file, content] of Object.entries({ ...files, '.gitignore': 'node_modules\n' })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  symlinkSync(join(cliRoot, 'node_modules'), join(root, 'node_modules'));
  if (frontend) symlinkSync(join(cliRoot, 'node_modules'), join(root, 'frontend/node_modules'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

/** What `cella style` reports for `file` from `rules`, the template's exceptions or `exceptions` applied. */
export function check(
  rules: Rule[],
  file: string,
  source: string,
  run: Partial<StyleRun> = {},
  exceptions: StyleExceptions = templateExceptions,
): Finding[] {
  return checkFile(rules, file, source, { root: cliRoot, files: [], stores: new Set(), owned: [], ...run }, exceptions);
}
