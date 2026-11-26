import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { maxBuffer } from './git';

/**
 * Write a file the CLI owns in the checkout, making its folder. Whatever is at the path goes first: a symlink
 * that arrived with a merge would carry the write outside the checkout.
 */
export async function writeOwnedFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await writeFile(path, content, 'utf8');
}

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
