/**
 * E2E test for shallow-clone recovery in ensureUpgradePoint.
 *
 * A shallow working clone (`git clone --depth`) has its history truncated below the graft point,
 * so the real common ancestor with upstream is absent: `git merge-base` finds nothing and upgrade
 * fails at the very first step. ensureUpgradePoint must detect the shallow state, deepen the history
 * from origin, and let native merge-base resolve the real ancestor: no graft required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureUpgradePoint } from '../../src/utils/git';
import { commitAll, createRepo, exec, gitUser, upstreamRemote, write } from '../helpers/test-env';

describe('ensureUpgradePoint shallow recovery', () => {
  let testDir: string;
  let upstreamPath: string;
  let originPath: string;
  let repoRoot: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-shallow-'));
    upstreamPath = path.join(testDir, 'upstream');
    originPath = path.join(testDir, 'origin');
    repoRoot = path.join(testDir, 'app');

    // Upstream: A -> B, the shared history the app was created from.
    createRepo(upstreamPath, { 'package.json': '{"name": "cella"}\n', 'README.md': '# Cella\n' });
    write(upstreamPath, { 'README.md': '# Cella\n\nmore\n' });
    commitAll(upstreamPath, 'B: shared ancestor');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('unshallows a shallow clone so native merge-base resolves the real ancestor', async () => {
    // Origin (the app's own remote, e.g. github.com/org/app): clone upstream fully, then diverge.
    exec(`git clone "${upstreamPath}" "${originPath}"`, testDir);
    exec(gitUser, originPath);
    write(originPath, { 'frontend/app.ts': 'export const app = true;\n' });
    commitAll(originPath, 'F1: app work');

    // Upstream moves on past the shared ancestor B.
    write(upstreamPath, { 'backend/index.ts': 'export const backend = true;\n' });
    const upstreamTip = commitAll(upstreamPath, 'C: upstream advances');

    // The working clone is SHALLOW (git clone --depth=1): history truncated below F1.
    exec(`git clone --depth=1 "file://${originPath}" "${repoRoot}"`, testDir);
    exec(gitUser, repoRoot);
    exec(`git remote add ${upstreamRemote} "${upstreamPath}"`, repoRoot);
    exec(`git fetch ${upstreamRemote}`, repoRoot);

    // Precondition: shallow, and merge-base finds nothing (the bug this recovers from).
    expect(exec('git rev-parse --is-shallow-repository', repoRoot)).toBe('true');
    expect(() => exec(`git merge-base HEAD ${upstreamRemote}/main`, repoRoot)).toThrow();

    await ensureUpgradePoint(repoRoot, 'HEAD', `${upstreamRemote}/main`);

    // History restored and the true common ancestor (B) is now discoverable natively.
    expect(exec('git rev-parse --is-shallow-repository', repoRoot)).toBe('false');
    const base = exec(`git merge-base HEAD ${upstreamRemote}/main`, repoRoot);
    const sharedAncestor = exec(`git rev-parse ${upstreamTip}~1`, repoRoot);
    expect(base).toBe(sharedAncestor);
  });
});
