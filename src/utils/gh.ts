/**
 * GitHub CLI (`gh`) helpers for the cella CLI.
 *
 * Thin wrappers around `gh` used by the sync service to open, list, merge, and close the sync pull
 * requests. Every wrapper degrades gracefully when `gh` is missing or a call fails, so a sync
 * run on a repo without `gh`/`origin` still works; it just skips the PR automation.
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
interface GhResult {
  ok: boolean;
  output: string;
}

/** Whether the GitHub CLI is available on PATH. */
export function ghAvailable(): boolean {
  return spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** Run `gh` in `cwd`, capturing stdout+stderr. Never throws. */
function runGh(cwd: string, args: string[]): GhResult {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output };
}

/**
 * List open upgrade PRs (head branch under one of `prefixes`, e.g. `cella/upgrade/`), newest first (highest PR number).
 * Returns an empty array when `gh` fails (no auth, no origin) so callers degrade to a no-op.
 */
export function listOpenSyncPrs(cwd: string, prefixes: string[]): GhPullRequest[] {
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

  return parsed
    .filter((pr) => prefixes.some((prefix) => pr.headRefName.startsWith(`${prefix}/`)))
    .sort((a, b) => b.number - a.number);
}

/**
 * Open a PR through the GitHub REST API. `gh pr create` goes through GraphQL, which a Claude
 * cloud session's GitHub proxy refuses. `repoSlug` is `owner/repo`; without it `gh` resolves
 * `{owner}/{repo}` from the current repository. When the create fails, `url` is the open PR for
 * the same head branch, if there is one (a PR that already exists gets a 422).
 */
export function createPr(
  cwd: string,
  repoSlug: string | null,
  pr: { base: string; head: string; title: string; body: string },
): GhResult & { url?: string } {
  const repo = repoSlug ?? '{owner}/{repo}';
  const fields = ['title', 'head', 'base', 'body'] as const;
  const created = runGh(cwd, [
    'api',
    `repos/${repo}/pulls`,
    '-X',
    'POST',
    ...fields.flatMap((field) => ['-f', `${field}=${pr[field]}`]),
    '--jq',
    '.html_url',
  ]);
  if (created.ok) return { ...created, url: created.output || undefined };

  const owner = repoSlug ? repoSlug.split('/')[0] : '{owner}';
  const existing = runGh(cwd, [
    'api',
    `repos/${repo}/pulls?state=open&head=${owner}:${pr.head}`,
    '--jq',
    '.[0].html_url // empty',
  ]);
  return { ...created, url: existing.ok && existing.output ? existing.output : undefined };
}

/** Squash-merge a PR (by number, branch, or URL) now; fails when the PR is not mergeable. */
export function mergePrSquash(cwd: string, ref: string | number, options: { deleteBranch?: boolean } = {}): GhResult {
  return runGh(cwd, ['pr', 'merge', String(ref), '--squash', ...(options.deleteBranch ? ['--delete-branch'] : [])]);
}

/** Close a PR without merging (used to discard superseded sync PRs). */
export function closePr(cwd: string, ref: string | number): GhResult {
  return runGh(cwd, ['pr', 'close', String(ref)]);
}
