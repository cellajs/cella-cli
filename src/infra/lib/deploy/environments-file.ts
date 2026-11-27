import { fetchDefaultHead, git } from './git-remote';
import { environmentsFile } from './target';

/** Where a default branch the move to `cella/infra/` has not reached keeps the environments file. */
const environmentsFileBeforeMove = 'infra/environments';

/**
 * The environments file at the head of the repository's default branch, at its path or else where it sat before the move to `cella/infra/`,
 * or '' when that commit has neither. The head is fetched into `dir`, an empty folder, without file contents, and then only this one file's
 * content.
 * @throws when the repository names no default branch or a git command fails.
 */
export async function readEnvironmentsFile(opts: { repository: string; key: string | undefined; dir: string }): Promise<string> {
  const head = await fetchDefaultHead(opts, ['--depth', '1', '--filter=blob:none']);
  for (const path of [environmentsFile, environmentsFileBeforeMove]) {
    const listed = (await git(opts.key, ['-C', opts.dir, 'ls-tree', head, path])).trim();
    if (listed) return git(opts.key, ['-C', opts.dir, 'cat-file', 'blob', `${head}:${path}`]);
  }
  return '';
}
