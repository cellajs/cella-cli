/**
 * E2E tests for withTemporarySyncBaseGraft.
 *
 * Squash syncs advance the recorded sync point (manifest + refs/cella/last-sync) without
 * advancing git's commit graph. A plain `git merge` then resolves 3-way against a stale
 * historical base and replays every upstream change since — hunks the fork already
 * integrated or deliberately resolved away re-apply as clean auto-merges (the classic
 * symptom: a duplicated block appearing in a fork file on every sync). The graft makes the
 * merge 3-way against the recorded sync point, scoped to the merge and local-only.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEffectiveMergeBase, merge, withTemporarySyncBaseGraft } from '../../src/utils/git';

const UPSTREAM_REMOTE = 'cella-upstream';
const GIT_USER = 'git config user.email "test@cellajs.com" && git config user.name "Cella Test"';

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(repoPath: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function commitAll(repoPath: string, message: string): string {
  exec('git add -A', repoPath);
  exec(`git commit -m "${message}"`, repoPath);
  return exec('git rev-parse HEAD', repoPath);
}

const FILE_BASE = 'export function getItems() {\n  const a = 1;\n  const b = 2;\n  return [a, b];\n}\n';
/** Upstream inserts this block; the fork's squash sync deliberately resolves it away. */
const UPSTREAM_BLOCK = '  // upstream-only scope block\n  const upstreamScope = true;\n';
const FILE_WITH_BLOCK = `export function getItems() {\n${UPSTREAM_BLOCK}  const a = 1;\n  const b = 2;\n  return [a, b];\n}\n`;

describe('withTemporarySyncBaseGraft', () => {
  let testDir: string;
  let upstreamPath: string;
  let forkPath: string;
  let upstreamBlockSha: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-graft-'));
    upstreamPath = path.join(testDir, 'upstream');
    forkPath = path.join(testDir, 'fork');

    // Upstream with real history the fork shares (a true fork, not a scaffold).
    fs.mkdirSync(upstreamPath);
    exec('git init -b main', upstreamPath);
    exec(GIT_USER, upstreamPath);
    write(upstreamPath, { 'backend/get-items.ts': FILE_BASE, 'shared/util.ts': 'export const util = 1;\n' });
    commitAll(upstreamPath, 'Initial commit');

    exec(`git clone "${upstreamPath}" "${forkPath}"`, testDir);
    exec(GIT_USER, forkPath);
    exec(`git remote add ${UPSTREAM_REMOTE} "${upstreamPath}"`, forkPath);

    // Upstream adds a block the fork does not want.
    write(upstreamPath, { 'backend/get-items.ts': FILE_WITH_BLOCK });
    upstreamBlockSha = commitAll(upstreamPath, 'feat: add upstream scope block');

    // The fork integrates that sync as a SQUASH commit (single parent — git's merge-base
    // stays at the initial commit) and resolves the block away, recording the sync point
    // in the committed manifest exactly like the sync engine does.
    write(forkPath, {
      'cella.manifest.json': `${JSON.stringify({ upstream: { commit: upstreamBlockSha } }, null, 2)}\n`,
    });
    commitAll(forkPath, 'chore: sync upstream (squash, block resolved away)');

    // Upstream moves on with an unrelated change, so the next sync has real content.
    write(upstreamPath, { 'shared/util.ts': 'export const util = 2;\n' });
    commitAll(upstreamPath, 'feat: bump util');
    exec(`git fetch ${UPSTREAM_REMOTE}`, forkPath);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('plain merge replays the resolved-away upstream block (the bug being fixed)', async () => {
    // Control: without the graft, git merges 3-way against the stale initial-commit base,
    // so the old upstream hunk re-applies as a clean auto-merge.
    await merge(forkPath, `${UPSTREAM_REMOTE}/main`, { noCommit: true, noEdit: true });

    const merged = fs.readFileSync(path.join(forkPath, 'backend/get-items.ts'), 'utf-8');
    expect(merged).toContain('upstreamScope');
  });

  it('grafted merge honors the recorded sync point: no ghost re-application, upstream news still lands', async () => {
    const { base, isStale } = await getEffectiveMergeBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`);
    expect(isStale).toBe(true);
    expect(base).toBe(upstreamBlockSha);

    const result = await withTemporarySyncBaseGraft(forkPath, 'HEAD', base, () =>
      merge(forkPath, `${UPSTREAM_REMOTE}/main`, { noCommit: true, noEdit: true }),
    );

    expect(result.conflicts).toEqual([]);
    // The block the fork resolved away must NOT come back...
    const merged = fs.readFileSync(path.join(forkPath, 'backend/get-items.ts'), 'utf-8');
    expect(merged).not.toContain('upstreamScope');
    // ...while genuinely new upstream work still syncs.
    expect(fs.readFileSync(path.join(forkPath, 'shared/util.ts'), 'utf-8')).toContain('util = 2');
    // A real in-progress merge is left for the caller (MERGE_HEAD intact)...
    expect(exec('git rev-parse -q --verify MERGE_HEAD', forkPath)).not.toBe('');
    // ...and the temporary replace ref is gone.
    expect(exec('git replace -l', forkPath)).toBe('');
  });

  it('removes the replace ref even when the merge conflicts', async () => {
    // Fork edits the same line upstream changes after the sync point → genuine conflict.
    write(forkPath, { 'shared/util.ts': 'export const util = "fork";\n' });
    commitAll(forkPath, 'fork: own util');

    const { base } = await getEffectiveMergeBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`);
    const result = await withTemporarySyncBaseGraft(forkPath, 'HEAD', base, () =>
      merge(forkPath, `${UPSTREAM_REMOTE}/main`, { noCommit: true, noEdit: true }),
    );

    expect(result.conflicts).toContain('shared/util.ts');
    expect(exec('git replace -l', forkPath)).toBe('');
    // The conflict is 3-way against the sync point, so the resolved-away block stays gone.
    const merged = fs.readFileSync(path.join(forkPath, 'backend/get-items.ts'), 'utf-8');
    expect(merged).not.toContain('upstreamScope');
  });

  it('no-ops when the base is already a native ancestor (fresh merge-commit history)', async () => {
    // A real two-parent merge of the sync point: git's own merge-base is current.
    exec(`git merge -s ours --no-edit ${upstreamBlockSha}`, forkPath);

    let replaceListDuringMerge: string | null = null;
    await withTemporarySyncBaseGraft(forkPath, 'HEAD', upstreamBlockSha, async () => {
      replaceListDuringMerge = exec('git replace -l', forkPath);
      return merge(forkPath, `${UPSTREAM_REMOTE}/main`, { noCommit: true, noEdit: true });
    });

    expect(replaceListDuringMerge).toBe('');
  });

  it('never clobbers an existing replacement object on the HEAD commit', async () => {
    const head = exec('git rev-parse HEAD', forkPath);
    const parent = exec('git rev-parse HEAD^', forkPath);
    // Graft HEAD onto its existing parent PLUS a fabricated orphan commit, so the
    // replacement object genuinely differs from the original (a same-parents graft is a
    // byte-identical commit when unsigned, which git refuses). The orphan does not make
    // upstreamBlockSha reachable, so the helper still hits the existing-replacement guard
    // rather than the native-ancestor guard.
    const tree = exec('git rev-parse HEAD^{tree}', forkPath);
    const orphan = exec(`git commit-tree ${tree} -m "distinct graft parent"`, forkPath);
    exec(`git replace -f --graft ${head} ${parent} ${orphan}`, forkPath);

    await withTemporarySyncBaseGraft(forkPath, 'HEAD', upstreamBlockSha, async () => 'ok');

    // The pre-existing replacement must survive untouched.
    expect(exec('git replace -l', forkPath)).toBe(head);
  });
});
