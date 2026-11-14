/**
 * E2E tests for ensureUpgradePoint on an app with unrelated history.
 *
 * A create-cella scaffold has a rootless initial commit with no shared history with upstream.
 * ensureUpgradePoint must read the `Cella-Base:` trailer create-cella stamps on that commit, graft
 * ancestry onto the recorded upstream commit, and record it as refs/cella/last-upgrade; without a
 * record that names a commit the app has, it stops with the manual-seed error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureUpgradePoint } from '../../src/upstream/upgrade-point';
import { commitAll, createRepo, exec, upstreamRemote, write } from '../helpers/test-env';

describe('ensureUpgradePoint scaffold trailer', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-base-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('grafts the app root onto the commit its Cella-Base trailer records', async () => {
    const upstreamPath = createRepo(path.join(testDir, 'upstream'), { 'README.md': '# Cella\n' });
    const recorded = exec('git rev-parse HEAD', upstreamPath);
    write(upstreamPath, { 'README.md': '# Cella, later\n' });
    commitAll(upstreamPath, 'later upstream work');

    const repoRoot = createRepo(path.join(testDir, 'app'));
    write(repoRoot, { 'README.md': '# My App\n' });
    exec(`git add -A && git commit -m "Initial commit" -m "Cella-Base: ${recorded}"`, repoRoot);
    exec(`git remote add ${upstreamRemote} "${upstreamPath}" && git fetch ${upstreamRemote}`, repoRoot);

    await ensureUpgradePoint(repoRoot, 'HEAD', `${upstreamRemote}/main`);

    expect(exec('git rev-parse refs/cella/last-upgrade', repoRoot)).toBe(recorded);
    expect(exec(`git merge-base HEAD ${upstreamRemote}/main`, repoRoot)).toBe(recorded);
  });

  it('stops with the manual-seed error when no record names a commit the app has', async () => {
    const upstreamPath = createRepo(path.join(testDir, 'upstream'), { 'README.md': '# Cella\n' });
    const missing = 'a'.repeat(40);
    const repoRoot = createRepo(path.join(testDir, 'app'));
    write(repoRoot, { 'cella/cella.manifest.json': JSON.stringify({ upstream: { commit: missing } }) });
    exec(`git add -A && git commit -m "Initial commit" -m "Cella-Base: ${missing}"`, repoRoot);
    exec(`git remote add ${upstreamRemote} "${upstreamPath}" && git fetch ${upstreamRemote}`, repoRoot);
    write(repoRoot, { '.git/refs/cella/last-upgrade': `${missing}\n` });

    await expect(ensureUpgradePoint(repoRoot, 'HEAD', `${upstreamRemote}/main`)).rejects.toThrow(
      'git update-ref refs/cella/last-upgrade <upstream-sha>',
    );
  });
});
