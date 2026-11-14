import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { maxBuffer } from './git';

/**
 * Repo-relative files git tracks, plus untracked ones it does not ignore, that exist on disk, each once, in
 * `git ls-files` order.
 */
export function listRepoFiles(repoPath: string): string[] {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer,
  });
  return [...new Set(output.split('\0'))].filter((file) => file && existsSync(join(repoPath, file)));
}

/**
 * Check if a file path is generated output an app regenerates itself: a `gen` path segment
 * (`sdk/gen/...`) or a `.gen.` file name (`routeTree.gen.ts`, `compose.gen.yml`). Upstream's
 * copy is never adopted, so upstream changes to it are not worth reporting.
 */
export function isGeneratedFile(filePath: string): boolean {
  const segments = filePath.split('/');
  return segments.includes('gen') || (segments.at(-1) ?? '').includes('.gen.');
}
