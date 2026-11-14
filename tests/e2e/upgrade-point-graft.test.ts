/**
 * E2E tests for withUpgradePointGraft.
 *
 * Squash upgrades advance the recorded upgrade point (manifest + refs/cella/last-upgrade) without
 * advancing git's commit graph. A plain `git merge` then resolves 3-way against a stale
 * historical base and replays every upstream change since: hunks the app already
 * integrated or deliberately resolved away re-apply as clean auto-merges (the classic
 * symptom: a duplicated block appearing in an app file on every upgrade). The graft makes the
 * merge 3-way against the recorded upgrade point, scoped to the merge and local-only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEffectiveMergeBase, withUpgradePointGraft } from '../../src/upstream/upgrade-point';
import { merge } from '../../src/utils/git';
import { commitAll, createRepo, exec, gitUser, upstreamRemote, write } from '../helpers/test-env';

const fileBase = 'export function getItems() {\n  const a = 1;\n  const b = 2;\n  return [a, b];\n}\n';
/** Upstream inserts this block; the app's squash upgrade deliberately resolves it away. */
const upstreamBlock = '  // upstream-only scope block\n  const upstreamScope = true;\n';
const fileWithBlock = `export function getItems() {\n${upstreamBlock}  const a = 1;\n  const b = 2;\n  return [a, b];\n}\n`;

describe('withUpgradePointGraft', () => {
  let testDir: string;
  let upstreamPath: string;
  let repoRoot: string;
  let upstreamBlockSha: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-graft-'));
    upstreamPath = path.join(testDir, 'upstream');
    repoRoot = path.join(testDir, 'app');

    // Upstream with real history the app shares (a true app, not a scaffold).
    createRepo(upstreamPath, { 'backend/get-items.ts': fileBase, 'shared/util.ts': 'export const util = 1;\n' });

    exec(`git clone "${upstreamPath}" "${repoRoot}"`, testDir);
    exec(gitUser, repoRoot);
    exec(`git remote add ${upstreamRemote} "${upstreamPath}"`, repoRoot);

    // Upstream adds a block the app does not want.
    write(upstreamPath, { 'backend/get-items.ts': fileWithBlock });
    upstreamBlockSha = commitAll(upstreamPath, 'feat: add upstream scope block');

    // The app integrates that upgrade as a SQUASH commit (single parent: git's merge-base
    // stays at the initial commit) and resolves the block away, recording the upgrade point
    // in the committed manifest exactly like the upgrade engine does.
    write(repoRoot, {
      'cella/cella.manifest.json': `${JSON.stringify({ upstream: { commit: upstreamBlockSha } }, null, 2)}\n`,
    });
    commitAll(repoRoot, 'chore: upgrade upstream (squash, block resolved away)');

    // Upstream moves on with an unrelated change, so the next upgrade has real content.
    write(upstreamPath, { 'shared/util.ts': 'export const util = 2;\n' });
    commitAll(upstreamPath, 'feat: bump util');
    exec(`git fetch ${upstreamRemote}`, repoRoot);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('plain merge replays the resolved-away upstream block (the bug being fixed)', async () => {
    // Control: without the graft, git merges 3-way against the stale initial-commit base,
    // so the old upstream hunk re-applies as a clean auto-merge.
    await merge(repoRoot, `${upstreamRemote}/main`);

    const merged = fs.readFileSync(path.join(repoRoot, 'backend/get-items.ts'), 'utf-8');
    expect(merged).toContain('upstreamScope');
  });

  it('grafted merge honors the recorded upgrade point: no ghost re-application, upstream news still lands', async () => {
    const base = await getEffectiveMergeBase(repoRoot, 'HEAD', `${upstreamRemote}/main`);
    expect(base).toBe(upstreamBlockSha);

    const result = await withUpgradePointGraft(repoRoot, 'HEAD', base, () => merge(repoRoot, `${upstreamRemote}/main`));

    expect(result.conflicts).toEqual([]);
    // The block the app resolved away must NOT come back...
    const merged = fs.readFileSync(path.join(repoRoot, 'backend/get-items.ts'), 'utf-8');
    expect(merged).not.toContain('upstreamScope');
    // ...while genuinely new upstream work still upgrades.
    expect(fs.readFileSync(path.join(repoRoot, 'shared/util.ts'), 'utf-8')).toContain('util = 2');
    // A real in-progress merge is left for the caller (MERGE_HEAD intact)...
    expect(exec('git rev-parse -q --verify MERGE_HEAD', repoRoot)).not.toBe('');
    // ...and the temporary replace ref is gone.
    expect(exec('git replace -l', repoRoot)).toBe('');
  });

  it('removes the replace ref even when the merge conflicts', async () => {
    // App edits the same line upstream changes after the upgrade point → genuine conflict.
    write(repoRoot, { 'shared/util.ts': 'export const util = "app";\n' });
    commitAll(repoRoot, 'app: own util');

    const base = await getEffectiveMergeBase(repoRoot, 'HEAD', `${upstreamRemote}/main`);
    const result = await withUpgradePointGraft(repoRoot, 'HEAD', base, () => merge(repoRoot, `${upstreamRemote}/main`));

    expect(result.conflicts).toContain('shared/util.ts');
    expect(exec('git replace -l', repoRoot)).toBe('');
    // The conflict is 3-way against the upgrade point, so the resolved-away block stays gone.
    const merged = fs.readFileSync(path.join(repoRoot, 'backend/get-items.ts'), 'utf-8');
    expect(merged).not.toContain('upstreamScope');
  });

  it('no-ops when the base is already a native ancestor (fresh merge-commit history)', async () => {
    // A real two-parent merge of the upgrade point: git's own merge-base is current.
    exec(`git merge -s ours --no-edit ${upstreamBlockSha}`, repoRoot);

    let replaceListDuringMerge: string | null = null;
    await withUpgradePointGraft(repoRoot, 'HEAD', upstreamBlockSha, async () => {
      replaceListDuringMerge = exec('git replace -l', repoRoot);
      return merge(repoRoot, `${upstreamRemote}/main`);
    });

    expect(replaceListDuringMerge).toBe('');
  });

  it('never clobbers an existing replacement object on the HEAD commit', async () => {
    const head = exec('git rev-parse HEAD', repoRoot);
    const parent = exec('git rev-parse HEAD^', repoRoot);
    // Graft HEAD onto its existing parent PLUS a fabricated orphan commit, so the
    // replacement object genuinely differs from the original (a same-parents graft is a
    // byte-identical commit when unsigned, which git refuses). The orphan does not make
    // upstreamBlockSha reachable, so the helper still hits the existing-replacement guard
    // rather than the native-ancestor guard.
    const tree = exec('git rev-parse HEAD^{tree}', repoRoot);
    const orphan = exec(`git commit-tree ${tree} -m "distinct graft parent"`, repoRoot);
    exec(`git replace -f --graft ${head} ${parent} ${orphan}`, repoRoot);

    await withUpgradePointGraft(repoRoot, 'HEAD', upstreamBlockSha, async () => 'ok');

    // The pre-existing replacement must survive untouched.
    expect(exec('git replace -l', repoRoot)).toBe(head);
  });
});
