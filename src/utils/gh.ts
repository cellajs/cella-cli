/**
 * GitHub CLI (`gh`) helpers for the cella CLI.
 *
 * Thin wrappers around `gh` used by the sync service to list, merge, and close the sync pull
 * requests. Every wrapper degrades gracefully when `gh` is missing or a call fails, so a sync
 * run on a repo without `gh`/`origin` still works — it just skips the PR automation.
 */

import { spawnSync } from 'node:child_process';

/** An open pull request, as returned by `gh pr list --json`. */
export interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  url: string;
}

/** Result of a `gh` invocation: whether it exited 0, plus its combined stdout+stderr. */
export interface GhResult {
  ok: boolean;
  output: string;
}

/** Whether the GitHub CLI is available on PATH. */
export function ghAvailable(): boolean {
  return spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** Run `gh` in `cwd`, capturing stdout+stderr. Never throws. */
function runGh(cwd: string, args: string[]): GhResult {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output };
}

/**
 * Keep only the pull requests whose head branch is one of cella's temporary sync branches
 * (under the `<prefix>/` namespace, e.g. `cella/sync/`). Pure — unit-tested.
 */
export function filterSyncPrs(prs: GhPullRequest[], prefix: string): GhPullRequest[] {
  return prs.filter((pr) => pr.headRefName.startsWith(`${prefix}/`));
}

/**
 * List open sync PRs (head branch under `<prefix>/`), newest first (highest PR number).
 * Returns an empty array when `gh` fails (no auth, no origin) so callers degrade to a no-op.
 */
export function listOpenSyncPrs(cwd: string, prefix: string): GhPullRequest[] {
  const { ok, output } = runGh(cwd, [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,headRefName,url',
    '--limit',
    '50',
  ]);
  if (!ok || !output) return [];

  let parsed: GhPullRequest[];
  try {
    parsed = JSON.parse(output) as GhPullRequest[];
  } catch {
    return [];
  }

  return filterSyncPrs(parsed, prefix).sort((a, b) => b.number - a.number);
}

/**
 * Build the argv for `gh pr merge`. Pure — unit-tested.
 *
 * `auto` uses GitHub auto-merge (the PR squashes once required checks pass); without it the
 * merge is attempted immediately and fails when the PR is not mergeable.
 */
export function buildMergeArgs(ref: string, options: { auto?: boolean; deleteBranch?: boolean } = {}): string[] {
  const args = ['pr', 'merge', ref, '--squash'];
  if (options.auto) args.push('--auto');
  if (options.deleteBranch) args.push('--delete-branch');
  return args;
}

/** Squash-merge a PR (by number, branch, or URL). See {@link buildMergeArgs}. */
export function mergePrSquash(
  cwd: string,
  ref: string | number,
  options: { auto?: boolean; deleteBranch?: boolean } = {},
): GhResult {
  return runGh(cwd, buildMergeArgs(String(ref), options));
}

/** Close a PR without merging (used to discard superseded sync PRs). */
export function closePr(cwd: string, ref: string | number): GhResult {
  return runGh(cwd, ['pr', 'close', String(ref)]);
}
