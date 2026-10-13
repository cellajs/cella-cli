/**
 * E2E tests for ensureSyncBase on a fork with unrelated history.
 *
 * A create-cella scaffold has a rootless initial commit with no shared history with upstream.
 * ensureSyncBase must read the `Cella-Base:` trailer create-cella stamps on that commit, graft
 * ancestry onto the recorded upstream commit, and record it as refs/cella/last-sync; without a
 * record that names a commit the fork has, it stops with the manual-seed error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSyncBase } from '../../src/utils/git';
import { commitAll, createRepo, exec, UPSTREAM_REMOTE, write } from '../helpers/test-env';

describe('ensureSyncBase scaffold trailer', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-base-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('grafts the fork root onto the commit its Cella-Base trailer records', async () => {
    const upstreamPath = createRepo(path.join(testDir, 'upstream'), { 'README.md': '# Cella\n' });
    const recorded = exec('git rev-parse HEAD', upstreamPath);
    write(upstreamPath, { 'README.md': '# Cella, later\n' });
    commitAll(upstreamPath, 'later upstream work');

    const forkPath = createRepo(path.join(testDir, 'fork'));
    write(forkPath, { 'README.md': '# My App\n' });
    exec(`git add -A && git commit -m "Initial commit" -m "Cella-Base: ${recorded}"`, forkPath);
    exec(`git remote add ${UPSTREAM_REMOTE} "${upstreamPath}" && git fetch ${UPSTREAM_REMOTE}`, forkPath);

    await ensureSyncBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`);

    expect(exec('git rev-parse refs/cella/last-sync', forkPath)).toBe(recorded);
    expect(exec(`git merge-base HEAD ${UPSTREAM_REMOTE}/main`, forkPath)).toBe(recorded);
  });

  it('stops with the manual-seed error when no record names a commit the fork has', async () => {
    const upstreamPath = createRepo(path.join(testDir, 'upstream'), { 'README.md': '# Cella\n' });
    const missing = 'a'.repeat(40);
    const forkPath = createRepo(path.join(testDir, 'fork'));
    write(forkPath, { 'cella/cella.manifest.json': JSON.stringify({ upstream: { commit: missing } }) });
    exec(`git add -A && git commit -m "Initial commit" -m "Cella-Base: ${missing}"`, forkPath);
    exec(`git remote add ${UPSTREAM_REMOTE} "${upstreamPath}" && git fetch ${UPSTREAM_REMOTE}`, forkPath);
    write(forkPath, { '.git/refs/cella/last-sync': `${missing}\n` });

    await expect(ensureSyncBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`)).rejects.toThrow(
      'git update-ref refs/cella/last-sync <upstream-sha>',
    );
  });
});
