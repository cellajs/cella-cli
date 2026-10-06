/**
 * E2E test for shallow-clone recovery in ensureSyncBase.
 *
 * A shallow working clone (`git clone --depth`) has its history truncated below the graft point,
 * so the real common ancestor with upstream is absent: `git merge-base` finds nothing and sync
 * fails at the very first step. ensureSyncBase must detect the shallow state, deepen the history
 * from origin, and let native merge-base resolve the real ancestor — no graft required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSyncBase } from '../../src/utils/git';
import { commitAll, exec, GIT_USER, UPSTREAM_REMOTE, write } from '../helpers/test-env';

describe('ensureSyncBase shallow recovery', () => {
  let testDir: string;
  let upstreamPath: string;
  let originPath: string;
  let forkPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-shallow-'));
    upstreamPath = path.join(testDir, 'upstream');
    originPath = path.join(testDir, 'origin');
    forkPath = path.join(testDir, 'fork');

    // Upstream: A -> B, the shared history the fork was created from.
    fs.mkdirSync(upstreamPath);
    exec('git init -b main', upstreamPath);
    exec(GIT_USER, upstreamPath);
    write(upstreamPath, { 'package.json': '{"name": "cella"}\n', 'README.md': '# Cella\n' });
    commitAll(upstreamPath, 'A: initial');
    write(upstreamPath, { 'README.md': '# Cella\n\nmore\n' });
    commitAll(upstreamPath, 'B: shared ancestor');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('unshallows a shallow clone so native merge-base resolves the real ancestor', async () => {
    // Origin (the fork's own remote, e.g. github.com/org/app): clone upstream fully, then diverge.
    exec(`git clone "${upstreamPath}" "${originPath}"`, testDir);
    exec(GIT_USER, originPath);
    write(originPath, { 'frontend/app.ts': 'export const app = true;\n' });
    commitAll(originPath, 'F1: fork work');

    // Upstream moves on past the shared ancestor B.
    write(upstreamPath, { 'backend/index.ts': 'export const backend = true;\n' });
    const upstreamTip = commitAll(upstreamPath, 'C: upstream advances');

    // The working clone is SHALLOW (git clone --depth=1): history truncated below F1.
    exec(`git clone --depth=1 "file://${originPath}" "${forkPath}"`, testDir);
    exec(GIT_USER, forkPath);
    exec(`git remote add ${UPSTREAM_REMOTE} "${upstreamPath}"`, forkPath);
    exec(`git fetch ${UPSTREAM_REMOTE}`, forkPath);

    // Precondition: shallow, and merge-base finds nothing (the bug this recovers from).
    expect(exec('git rev-parse --is-shallow-repository', forkPath)).toBe('true');
    expect(() => exec(`git merge-base HEAD ${UPSTREAM_REMOTE}/main`, forkPath)).toThrow();

    await ensureSyncBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`);

    // History restored and the true common ancestor (B) is now discoverable natively.
    expect(exec('git rev-parse --is-shallow-repository', forkPath)).toBe('false');
    const base = exec(`git merge-base HEAD ${UPSTREAM_REMOTE}/main`, forkPath);
    const sharedAncestor = exec(`git rev-parse ${upstreamTip}~1`, forkPath);
    expect(base).toBe(sharedAncestor);
  });
});
