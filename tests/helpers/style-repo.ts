import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
