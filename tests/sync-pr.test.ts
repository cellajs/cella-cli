/**
 * Unit tests for the sync PR content builders.
 *
 * Covers buildSyncPrBody (pure markdown rendering, including upstream PR-ref qualification and
 * truncation) and the git readers that recover the sync range from committed manifests.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSyncPrBody } from '../src/services/sync';
import { readManifestAtRef, readManifestBaseAtRef, readPackageVersionAtRef } from '../src/utils/git';

/** Execute a shell command in a directory */
function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Create a minimal git repo with an initial commit */
function createRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-git-test-'));
  // -b main: don't depend on the runner's init.defaultBranch (CI defaults to master).
  exec('git init -b main', dir);
  exec('git config user.email "test@test.com" && git config user.name "Test"', dir);
  fs.writeFileSync(path.join(dir, 'initial.txt'), 'initial\n');
  exec('git add -A && git commit -m "initial"', dir);
  return dir;
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('buildSyncPrBody', () => {
  it('renders header, compare link and linked commit list', () => {
    const body = buildSyncPrBody({
      repoSlug: 'cellajs/cella',
      version: '0.2.2',
      fromSha: SHA_A,
      toSha: SHA_B,
      totalCount: 2,
      commits: [
        { hash: SHA_A, message: 'fix: type in yjs Dockerfile (#843)', date: '2 days ago' },
        { hash: SHA_B, message: 'feat: log refactor (#848)', date: 'yesterday' },
      ],
    });

    expect(body).toContain('Syncs upstream [cellajs/cella](https://github.com/cellajs/cella)');
    expect(body).toContain(`[\`${'b'.repeat(7)}\`](https://github.com/cellajs/cella/commit/${SHA_B}) (v0.2.2).`);
    expect(body).toContain('**2 upstream commits since last sync**');
    expect(body).toContain(`[compare](https://github.com/cellajs/cella/compare/${'a'.repeat(7)}...${'b'.repeat(7)})`);
    // Bare #843 would auto-link to the fork's own PR — must be qualified with the upstream slug.
    expect(body).toContain('fix: type in yjs Dockerfile (cellajs/cella#843)');
    expect(body).not.toContain('(#843)');
  });

  it('normalizes a v-prefixed release tag', () => {
    const body = buildSyncPrBody({
      repoSlug: 'cellajs/cella',
      version: 'v1.2.3',
      toSha: SHA_B,
      totalCount: 0,
      commits: [],
    });
    expect(body).toContain('(v1.2.3).');
    expect(body).not.toContain('vv1.2.3');
  });

  it('notes earlier commits when the list is truncated', () => {
    const body = buildSyncPrBody({
      repoSlug: 'cellajs/cella',
      version: null,
      fromSha: SHA_A,
      toSha: SHA_B,
      totalCount: 60,
      commits: [{ hash: SHA_B, message: 'feat: latest', date: 'today' }],
    });
    expect(body).toContain('**60 upstream commits since last sync**');
    expect(body).toContain('- …59 earlier commit(s) not shown');
  });

  it('omits the commit section when the range is unknown', () => {
    const body = buildSyncPrBody({
      repoSlug: 'cellajs/cella',
      version: '0.2.2',
      fromSha: null,
      toSha: SHA_B,
      totalCount: 0,
      commits: [],
    });
    expect(body).toContain('Syncs upstream');
    expect(body).not.toContain('since last sync');
  });

  it('degrades to plain text without a repo slug', () => {
    const body = buildSyncPrBody({
      version: null,
      fromSha: SHA_A,
      toSha: SHA_B,
      totalCount: 1,
      commits: [{ hash: SHA_A, message: 'fix: thing (#12)', date: 'today' }],
    });
    expect(body).toContain('Syncs upstream cella to `bbbbbbb`.');
    expect(body).toContain('- `aaaaaaa` fix: thing (#12)');
    expect(body).not.toContain('https://github.com');
  });
});

describe('manifest and version readers', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createRepo();
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('reads the manifest committed at a ref, not the working tree', async () => {
    const committed = { upstream: { repo: 'cellajs/cella', commit: SHA_A, release: null } };
    fs.writeFileSync(path.join(repoPath, 'cella.manifest.json'), JSON.stringify(committed));
    exec('git add -A && git commit -m "chore: manifest"', repoPath);

    // Worktree moves ahead (staged sync) — the committed manifest must still win.
    fs.writeFileSync(path.join(repoPath, 'cella.manifest.json'), JSON.stringify({ upstream: { commit: SHA_B } }));

    const manifest = await readManifestAtRef(repoPath, 'HEAD');
    expect(manifest?.upstream.repo).toBe('cellajs/cella');
    expect(await readManifestBaseAtRef(repoPath, 'HEAD')).toBe(SHA_A);
  });

  it('returns null for a missing or malformed manifest', async () => {
    expect(await readManifestAtRef(repoPath, 'HEAD')).toBeNull();

    fs.writeFileSync(path.join(repoPath, 'cella.manifest.json'), '{"upstream":{"commit":"nope"}}');
    exec('git add -A && git commit -m "chore: bad manifest"', repoPath);
    expect(await readManifestAtRef(repoPath, 'HEAD')).toBeNull();
    expect(await readManifestBaseAtRef(repoPath, 'HEAD')).toBeNull();
  });

  it('reads the package.json version at a ref', async () => {
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'cella', version: '0.2.2' }));
    exec('git add -A && git commit -m "chore: package"', repoPath);
    expect(await readPackageVersionAtRef(repoPath, 'HEAD')).toBe('0.2.2');
    expect(await readPackageVersionAtRef(repoPath, 'HEAD~1')).toBeNull();

    fs.writeFileSync(path.join(repoPath, 'package.json'), '{not json');
    exec('git add -A && git commit -m "chore: break package"', repoPath);
    expect(await readPackageVersionAtRef(repoPath, 'HEAD')).toBeNull();
  });
});
