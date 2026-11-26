/**
 * Adopt command for the cella CLI, run in upstream cella: pick one of the configured `forks`, pull
 * its `pullBranch` onto a clean local `contrib/<fork>` branch that holds only the fork's
 * contributed files (see adopt-branch.ts), then review them and adopt single files into the
 * working tree.
 */

import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isUpKey,
  useKeypress,
  usePagination,
  useState,
} from '@inquirer/core';
import { select } from '@inquirer/prompts';
import { resolveAppModuleFolders } from '../config/app-modules';
import { printNoForksHint, resolveForkBasePath, type ValidatedFork, validateForkPath } from '../config/forks';
import { defaultBranch, isUpstreamRepo } from '../config/load';
import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import {
  checkMark,
  createSpinner,
  divider,
  spinnerFail,
  spinnerSuccess,
  warningMark,
  writeStdout,
} from '../utils/display';
import { errorMessage } from '../utils/errors';
import {
  checkoutFromRef,
  getCurrentBranch,
  getDiffStat,
  git,
  gitRm,
  removeFileFromWorktree,
  restoreWorktreeFromRef,
} from '../utils/git';
import { buildContribBranch, type ContribFile, detectContributableFiles } from './adopt-branch';
import { parseOverrideLists } from './config-gate';
import { gitDiffFile, openInBrowser, writeDiffPage } from './diff-page';
import { configFile } from './managed-files';

interface ContribItem extends ContribFile {
  /** Lines added in the fork vs cella base (null for binary files) */
  additions: number | null;
  /** Lines removed in the fork vs cella base (null for binary files) */
  deletions: number | null;
  /** Whether file is selected for acceptance */
  checked: boolean;
}

interface ContribPromptConfig {
  message: string;
  items: ContribItem[];
  /** Name of the fork being reviewed (used to label diffs cella/ vs <fork>/) */
  forkName: string;
  /** Base ref the contrib branch was built on (for diffing) */
  baseRef: string;
  /** The local `contrib/<fork>` branch holding the fork's files */
  branch: string;
  /** Repo path where contrib branches live */
  cwd: string;
}

/** The review screen: a list of the fork's files to select, with a browser diff per file; resolves to the selected ones. */
const contribPrompt = createPrompt<ContribItem[], ContribPromptConfig>((config, done) => {
  const { baseRef, branch, cwd, forkName } = config;

  const [items, setItems] = useState<ContribItem[]>(config.items);
  const [active, setActive] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [promptStatus, setPromptStatus] = useState<'idle' | 'done'>('idle');

  useKeypress(async (key) => {
    if (key.name === 'q') {
      setPromptStatus('done');
      done([]);
      return;
    }

    if (isEnterKey(key)) {
      const selected = items.filter((i) => i.checked);
      if (selected.length === 0) {
        setStatusMsg('select files with space first, or q to quit');
        return;
      }
      setPromptStatus('done');
      done(selected);
      return;
    }

    // ctrl jumps to the first or last item
    if (isUpKey(key) || isDownKey(key)) {
      const to = key.ctrl ? (isUpKey(key) ? 0 : items.length - 1) : active + (isUpKey(key) ? -1 : 1);
      setActive(Math.min(items.length - 1, Math.max(0, to)));
      setStatusMsg('');
      return;
    }

    if (isSpaceKey(key)) {
      setItems(items.map((item, i) => (i === active ? { ...item, checked: !item.checked } : item)));
      return;
    }

    // d = open diff in browser (non-blocking, the list stays up)
    if (key.name === 'd') {
      const { path } = items[active];
      try {
        const patch = await gitDiffFile(cwd, `${baseRef}..${branch}`, path);
        if (patch.length === 0) return setStatusMsg(`no changes for ${path}`);
        const page = await writeDiffPage(
          [{ files: [{ path, patch: patch.toString() }] }],
          { title: path, note: `cella ← → ${forkName}` },
          cwd,
          path,
        );
        setStatusMsg(openInBrowser(page) ? `opened ${path} in browser` : `diff page: ${page}`);
      } catch (error) {
        setStatusMsg(`diff failed: ${errorMessage(error)}`);
      }
      return;
    }

    if (key.name === 'a') {
      const allChecked = items.every((item) => item.checked);
      setItems(items.map((item) => ({ ...item, checked: !allChecked })));
      setStatusMsg(allChecked ? 'deselected all' : 'selected all');
      return;
    }
  });

  const checkedCount = items.filter((i) => i.checked).length;
  if (promptStatus === 'done')
    return checkedCount > 0 ? `${checkMark} ${checkedCount} files accepted` : `${checkMark} done`;

  const page = usePagination({
    items,
    active,
    renderItem({ item, isActive }) {
      const checkbox = item.checked ? pc.green('●') : pc.dim('○');
      const cursor = isActive ? pc.cyan('❯') : ' ';
      const newLabel = item.kind === 'created' ? pc.yellow(' · not in cella') : '';
      const delLabel = item.kind === 'deleted' ? pc.yellow(' [del]') : '';
      const statusTag = item.status === 'diverged' ? pc.yellow(' ⚠ diverged') : '';
      const dateLabel = item.changedAt ? pc.dim(` · ${item.changedAt}`) : '';
      const line = `${cursor} ${checkbox} ${item.path}${delLabel}${statusTag}${newLabel}${dateLabel}`;
      return isActive ? pc.cyan(line) : line;
    },
    pageSize: 20,
    loop: false,
  });

  const countInfo =
    checkedCount > 0 ? `${items.length} files, ${pc.green(`${checkedCount} selected`)}` : `${items.length} files`;
  const header = `${pc.cyan('⬇')} ${config.message} ${pc.dim(`(${countInfo})`)}`;

  const keys: [string, string][] = [
    ['↑↓', 'navigate'],
    ['d', 'diff in browser'],
    ['a', '(de)select all'],
    ['space', 'select'],
    ['⏎', 'accept'],
    ['q', 'quit'],
  ];
  const helpLine = keys.map(([k, a]) => `${pc.bold(k)} ${pc.dim(a)}`).join(pc.dim(' · '));

  const statusLine = statusMsg ? `  ${pc.dim(statusMsg)}` : '';

  const lines = [header, page, statusLine, helpLine].filter(Boolean).join('\n').trimEnd();
  return `${lines}\x1B[?25l`;
});

/** The fork to pull from, by name (skips the fork prompt), and the JSON output for tooling. */
export interface AdoptOptions {
  fork?: string;
  json: boolean;
}

/**
 * Resolve the fork to pull from: the explicit --fork by name, the single valid fork with --json,
 * or an interactive prompt. Throws when no fork can be selected; returns undefined only when the
 * prompt selects nothing.
 */
async function selectFork(options: AdoptOptions, validated: ValidatedFork[]): Promise<ValidatedFork | undefined> {
  if (options.fork) {
    const match = validated.find((v) => v.fork.name === options.fork);
    if (!match?.valid) {
      throw new Error(`fork '${options.fork}' not found or invalid in config`);
    }
    return match;
  }

  if (options.json) {
    const validForks = validated.filter((v) => v.valid);
    if (validForks.length === 0) throw new Error('no valid forks configured');
    if (validForks.length > 1) throw new Error('multiple forks configured; pass --fork <name> to choose one');
    return validForks[0];
  }

  const choices = validated.map((v) => ({
    value: v.fork.name,
    name: v.valid
      ? `${v.fork.name}  ${pc.dim(`[${v.fork.pullBranch}] ${v.fork.localPath}`)}`
      : `${v.fork.name}  ${pc.dim(v.fork.localPath)}`,
    disabled: v.valid ? false : (v.error ?? 'invalid'),
  }));
  const picked = await select<string>({
    message: 'select fork to pull contributions from:',
    choices,
    loop: false,
  });
  const selected = validated.find((v) => v.fork.name === picked);
  if (!selected) console.info(pc.dim('no fork selected.'));
  return selected;
}

/** What a fork offers: its files on a fresh `contrib/<fork>` branch, and the commit they were read at. */
interface Contributions {
  items: ContribItem[];
  branch: string;
  /** Short sha and relative date of the fork's committed `pullBranch` head. */
  head: { sha: string; date: string };
}

/**
 * Fetch the fork's `pullBranch` and collect the files it contributes against `baseRef` on a local
 * `contrib/<fork>` branch, the most recent fork change first; no items when it offers none.
 */
async function collectContributions(
  config: RuntimeConfig,
  { fork, resolvedPath }: ValidatedFork,
  baseRef: string,
): Promise<Contributions> {
  const { repoRoot } = config;
  // The fork's remote holds its committed ref, ahead of the local clone.
  await git(['fetch', fork.remoteUrl ?? resolvedPath, fork.pullBranch], repoRoot);
  const forkRef = await git(['rev-parse', 'FETCH_HEAD'], repoRoot);
  const meta = await git(['log', '-1', '--format=%h%x09%cr', forkRef], repoRoot, { ignoreErrors: true });
  const [sha = forkRef.slice(0, 7), date = 'unknown'] = meta.split('\t');
  const empty: Contributions = { items: [], branch: '', head: { sha, date } };

  // The other repository's `ignored` folders and app modules hold its own code, read as text: none of it runs.
  const forkConfig = await git(['show', `${forkRef}:${configFile}`], repoRoot, { ignoreErrors: true });
  const forkTerritory = [...(parseOverrideLists(forkConfig)?.ignored ?? []), ...resolveAppModuleFolders(resolvedPath)];
  const files = await detectContributableFiles(repoRoot, baseRef, forkRef, config, forkTerritory);
  if (files.length === 0) return empty;
  const { branch, appliedFiles } = await buildContribBranch(repoRoot, baseRef, forkRef, files, fork.name);
  if (appliedFiles.length === 0) return empty;

  const stat = await getDiffStat(repoRoot, baseRef, branch);
  const items = files.map((file): ContribItem => {
    const { additions = null, deletions = null } = stat.get(file.path) ?? {};
    return { ...file, additions, deletions, checked: false };
  });
  // Undated files last, path as tie-breaker: the top shows where the fork last drifted apart.
  items.sort((a, b) => (b.changedTs ?? 0) - (a.changedTs ?? 0) || a.path.localeCompare(b.path));
  return { ...empty, items, branch };
}

/** Bring the selected files from `branch` into the working tree, unstaged or staged; returns one error line per file that failed. */
async function applyContributions(
  repoRoot: string,
  branch: string,
  selected: ContribItem[],
  unstaged: boolean,
): Promise<string[]> {
  const errors: string[] = [];
  for (const { path, kind } of selected) {
    // Reject paths with traversal components (CWE-22)
    if (path.includes('..') || path.startsWith('/')) {
      errors.push(`${path}: rejected (path traversal)`);
      continue;
    }
    try {
      if (kind === 'deleted') await (unstaged ? removeFileFromWorktree(repoRoot, path) : gitRm(repoRoot, [path]));
      else
        await (unstaged ? restoreWorktreeFromRef(repoRoot, branch, path) : checkoutFromRef(repoRoot, branch, [path]));
    } catch (error) {
      errors.push(`${path}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

/**
 * Run the adopt command: pick a fork, collect what it contributes, then print it as JSON or review
 * it and apply the selected files. Returns 1 without forks to adopt from, when the pull failed and
 * when a file did not apply.
 */
export async function runAdopt(config: RuntimeConfig, options: AdoptOptions): Promise<number> {
  const forks = config.forks ?? [];
  if (forks.length === 0) {
    printNoForksHint('add forks to pull contributions from:');
    return 1;
  }

  // Forks compare against the checked-out branch, so contributions reflect the branch you are working on.
  const baseRef = await getCurrentBranch(config.repoRoot);
  // The comparison is a 3-way analysis against merge-base(baseRef, fork): a long-lived feature branch
  // has an older merge-base than 'main' and may show extra 'diverged' files.
  if (baseRef !== defaultBranch) {
    console.info(
      `${warningMark} ${pc.yellow(`not on base branch '${defaultBranch}'`)} ${pc.dim(`comparing forks against '${baseRef}'`)}`,
    );
    console.info(
      `  ${pc.dim(`older merge-base may show extra 'diverged' files; switch to '${defaultBranch}' for the cleanest result`)}`,
    );
    console.info('');
  }

  const forkBasePath = await resolveForkBasePath(config.repoRoot);
  const selectedFork = await selectFork(
    options,
    forks.map((fork) => validateForkPath(fork, forkBasePath)),
  );
  if (!selectedFork) return 0;
  const { name: forkName, pullBranch } = selectedFork.fork;

  createSpinner('pulling fork contributions...');
  let contributions: Contributions;
  try {
    contributions = await collectContributions(config, selectedFork, baseRef);
  } catch (error) {
    spinnerFail(`failed to pull ${forkName}`);
    console.info(pc.red(`  ✗ ${errorMessage(error)}`));
    return 1;
  }
  const { items, branch, head } = contributions;
  if (items.length === 0) {
    spinnerSuccess('no contributions found');
    return 0;
  }

  spinnerSuccess(`${items.length} files from ${forkName}`);
  // The fork is compared at its committed head, so uncommitted fork edits never show here.
  console.info(
    `  ${pc.dim(`${forkName}: comparing committed '${pullBranch}' @ ${head.sha} (${head.date}); uncommitted fork changes are not included`)}`,
  );

  if (options.json) {
    const out = items.map((item) => ({
      fork: forkName,
      path: item.path,
      status: item.status,
      kind: item.kind === 'deleted' ? 'deleted' : 'modified',
      changedAt: item.changedAt ?? null,
      changedTs: item.changedTs ?? null,
      additions: item.additions,
      deletions: item.deletions,
    }));
    writeStdout(JSON.stringify(out, null, 2));
    return 0;
  }

  console.info();
  console.info(divider);
  const selected = await contribPrompt({
    message: `contributions from ${forkName}`,
    items,
    forkName,
    baseRef,
    branch,
    cwd: config.repoRoot,
  });
  if (selected.length === 0) {
    console.info();
    return 0;
  }

  // Unstaged in upstream cella, staged in a fork.
  createSpinner(`applying ${selected.length} files...`);
  const unstaged = isUpstreamRepo(config.repoRoot);
  const errors = await applyContributions(config.repoRoot, branch, selected, unstaged);
  if (errors.length > 0) {
    spinnerFail(`applied ${selected.length - errors.length}/${selected.length} files (${errors.length} errors)`);
    for (const error of errors) console.info(pc.red(`  ✗ ${error}`));
  } else {
    spinnerSuccess(`applied ${selected.length} files ${pc.dim(unstaged ? '(unstaged)' : '(staged)')}`);
  }

  // No per-file summary: the applied files are visible in the IDE's source control view.
  console.info();
  console.info(
    pc.dim(
      unstaged
        ? '  files are unstaged: review, stage what you want, and commit when ready'
        : '  files are staged: review and commit when ready',
    ),
  );
  console.info();
  return errors.length > 0 ? 1 : 0;
}
