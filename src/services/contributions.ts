/**
 * Contributions service for sync CLI.
 *
 * Upstream-side (cella): based on the configured `forks`, lets the user pick a
 * single fork, pulls its `pullBranch` and builds a clean local `contrib/<fork>`
 * branch with only that fork's contributed files. Then shows an interactive TUI
 * to review and adopt individual files into the working tree.
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
import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { DEFAULT_BRANCH, isUpstreamRepo, loadConfig } from '../utils/config';
import { gitDiffFile, openDiffInBrowser } from '../utils/diff';
import {
  checkMark,
  createSpinner,
  DIVIDER,
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
import { buildContribBranch, type ContribFile, detectContributableFiles } from './contrib-core';
import { printNoForksHint, resolveForkBasePath, type ValidatedFork, validateForkPath } from './fork-utils';

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
  pageSize?: number;
}

/**
 * Interactive prompt for reviewing contributed files.
 * Returns items selected for acceptance.
 */
const contribPrompt = createPrompt<ContribItem[], ContribPromptConfig>((config, done) => {
  const { pageSize = 20, baseRef, branch, cwd, forkName } = config;

  const [items, setItems] = useState<ContribItem[]>(config.items);
  const [active, setActive] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [promptStatus, setPromptStatus] = useState<'idle' | 'done'>('idle');

  useKeypress(async (key) => {
    const last = items.length - 1;

    if (items.length === 0) {
      if (isEnterKey(key) || key.name === 'q') {
        setPromptStatus('done');
        done([]);
      }
      return;
    }

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

    // Navigation
    if (key.ctrl && isUpKey(key)) {
      setActive(0);
      setStatusMsg('');
      return;
    }
    if (key.ctrl && isDownKey(key)) {
      setActive(last);
      setStatusMsg('');
      return;
    }
    if (isUpKey(key)) {
      setActive(active <= 0 ? 0 : active - 1);
      setStatusMsg('');
      return;
    }
    if (isDownKey(key)) {
      setActive(active >= last ? last : active + 1);
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
        const patch = gitDiffFile(cwd, `${baseRef}..${branch}`, path);
        if (patch.length === 0) return setStatusMsg(`no changes for ${path}`);
        await openDiffInBrowser(patch.toString(), { filePath: path, srcLabel: 'cella', dstLabel: forkName }, cwd);
        setStatusMsg(`opened ${path} in browser`);
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

  // Render: done state
  if (promptStatus === 'done') {
    const checked = items.filter((i) => i.checked);
    if (checked.length > 0) {
      return `${checkMark} ${checked.length} files accepted`;
    }
    return `${checkMark} done`;
  }

  // Render: empty
  if (items.length === 0) {
    return `${checkMark} no contributions: press enter`;
  }

  // Render: paginated list
  const checkedCount = items.filter((i) => i.checked).length;

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
    pageSize,
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

/**
 * Resolve the fork to pull from: the explicit --fork by name, the single valid fork with --json,
 * or an interactive prompt. Throws when no fork can be selected; returns undefined only when the
 * prompt selects nothing.
 */
async function selectFork(config: RuntimeConfig, validated: ValidatedFork[]): Promise<ValidatedFork | undefined> {
  if (config.fork) {
    const match = validated.find((v) => v.fork.name === config.fork);
    if (!match?.valid) {
      throw new Error(`fork '${config.fork}' not found or invalid in config`);
    }
    return match;
  }

  if (config.json) {
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

/** Short sha + relative date of the fork's committed pullBranch HEAD (for the comparison banner). */
async function forkRefMeta(cellaPath: string, forkRef: string): Promise<{ sha: string; date: string }> {
  const out = await git(['log', '-1', '--format=%h%x09%cr', forkRef], cellaPath, { ignoreErrors: true });
  const [sha = forkRef.slice(0, 7), date = 'unknown'] = out.split('\t');
  return { sha, date };
}

/**
 * Run the contributions service.
 *
 * Based on the configured `forks`, lets the user select one fork, pulls its
 * `pullBranch`, builds a clean local `contrib/<fork>` branch, then presents
 * an interactive TUI to review and adopt individual files.
 */
export async function runContributions(config: RuntimeConfig): Promise<void> {
  const forks = config.forks ?? [];

  if (forks.length === 0) {
    printNoForksHint('add forks to pull contributions from:');
    return;
  }

  // Compare forks against cella's currently checked-out branch, not a fixed
  // configured branch, so contributions reflect the branch you're working on.
  const baseRef = await getCurrentBranch(config.forkPath);

  // Warn when not on cella's base branch. The comparison is a 3-way analysis against
  // merge-base(baseRef, fork), so a long-lived feature branch has an older merge-base
  // than 'main' and may surface extra 'diverged' files that would show clean from main.
  if (baseRef !== DEFAULT_BRANCH) {
    console.info(
      `${warningMark} ${pc.yellow(`not on base branch '${DEFAULT_BRANCH}'`)} ${pc.dim(`comparing forks against '${baseRef}'`)}`,
    );
    console.info(
      `  ${pc.dim(`older merge-base may show extra 'diverged' files; switch to '${DEFAULT_BRANCH}' for the cleanest result`)}`,
    );
    console.info('');
  }

  const forkBasePath = await resolveForkBasePath(config.forkPath);
  const validated = forks.map((fork) => validateForkPath(fork, forkBasePath));

  const selectedFork = await selectFork(config, validated);
  if (!selectedFork) return;

  const { fork, resolvedPath } = selectedFork;
  const forkName = fork.name;

  createSpinner('pulling fork contributions...');
  const allItems: ContribItem[] = [];
  let forkBanner: { pullBranch: string; sha: string; date: string } | null = null;
  let branch = '';

  try {
    // Prefer the fork's remote (authoritative committed ref) over the local clone.
    await git(['fetch', fork.remoteUrl ?? resolvedPath, fork.pullBranch], config.forkPath);
    const forkRef = await git(['rev-parse', 'FETCH_HEAD'], config.forkPath);
    const meta = await forkRefMeta(config.forkPath, forkRef);
    forkBanner = { pullBranch: fork.pullBranch, sha: meta.sha, date: meta.date };

    // Read the fork's own owned folders so its fork-specific modules aren't offered back
    let forkTerritory: string[] = [];
    try {
      const forkConfig = await loadConfig(resolvedPath);
      forkTerritory = forkConfig.overrides?.ignored ?? [];
    } catch {
      // Fork may not have a cella/cella.config.ts: no extra territory to exclude
    }

    const files = await detectContributableFiles(config.forkPath, baseRef, forkRef, config, forkTerritory);
    if (files.length > 0) {
      const built = await buildContribBranch(config.forkPath, baseRef, forkRef, files, forkName);
      if (built.appliedFiles.length > 0) {
        branch = built.branch;
        const stat = await getDiffStat(config.forkPath, baseRef, branch);
        for (const file of files) {
          const { additions = null, deletions = null } = stat.get(file.path) ?? {};
          allItems.push({ ...file, additions, deletions, checked: false });
        }
      }
    }
  } catch (error) {
    spinnerFail(`failed to pull ${forkName}`);
    console.info(pc.red(`  ✗ ${errorMessage(error)}`));
    return;
  }

  if (allItems.length === 0) {
    spinnerSuccess('no contributions found');
    return;
  }

  // Sort by most recent fork change first (undated files last), path as tie-breaker,
  // so the top of the list shows where the fork last drifted (further) apart.
  allItems.sort((a, b) => (b.changedTs ?? 0) - (a.changedTs ?? 0) || a.path.localeCompare(b.path));

  spinnerSuccess(`${allItems.length} files from ${forkName}`);

  // Make the comparison basis explicit: the fork is compared at its committed pullBranch HEAD,
  // not its working tree, so uncommitted fork edits never appear here.
  if (forkBanner) {
    console.info(
      `  ${pc.dim(`${forkName}: comparing committed '${forkBanner.pullBranch}' @ ${forkBanner.sha} (${forkBanner.date}); uncommitted fork changes are not included`)}`,
    );
  }

  // Machine-readable JSON output for tooling/agent usage
  if (config.json) {
    const out = allItems.map((item) => ({
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
    return;
  }

  console.info();
  console.info(DIVIDER);

  const selected = await contribPrompt({
    message: `contributions from ${forkName}`,
    items: allItems,
    forkName,
    baseRef,
    branch,
    cwd: config.forkPath,
    pageSize: 20,
  });

  if (selected.length === 0) {
    console.info();
    return;
  }

  // Apply selected files into the working tree (unstaged in upstream cella, staged in a fork)
  createSpinner(`applying ${selected.length} files...`);
  const applyUnstaged = isUpstreamRepo(config.forkPath);

  let applied = 0;
  const errors: string[] = [];

  for (const item of selected) {
    try {
      // Reject paths with traversal components (CWE-22)
      if (item.path.includes('..') || item.path.startsWith('/')) {
        errors.push(`${item.path}: rejected (path traversal)`);
        continue;
      }
      if (item.kind === 'deleted') {
        if (applyUnstaged) {
          await removeFileFromWorktree(config.forkPath, item.path);
        } else {
          await gitRm(config.forkPath, [item.path]);
        }
      } else {
        if (applyUnstaged) {
          await restoreWorktreeFromRef(config.forkPath, branch, item.path);
        } else {
          await checkoutFromRef(config.forkPath, branch, [item.path]);
        }
      }
      applied++;
    } catch (error) {
      errors.push(`${item.path}: ${errorMessage(error)}`);
    }
  }

  if (errors.length > 0) {
    spinnerFail(`applied ${applied}/${selected.length} files (${errors.length} errors)`);
    for (const err of errors) {
      console.info(pc.red(`  ✗ ${err}`));
    }
  } else {
    spinnerSuccess(`applied ${applied} files ${pc.dim(applyUnstaged ? '(unstaged)' : '(staged)')}`);
  }

  // No per-file summary: the applied files are visible in the IDE's source control view.
  console.info();
  console.info(
    pc.dim(
      applyUnstaged
        ? '  files are unstaged: review, stage what you want, and commit when ready'
        : '  files are staged: review and commit when ready',
    ),
  );
  console.info();
}
