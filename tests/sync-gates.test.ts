/**
 * Tests for `cella sync` runs that stop before the merge.
 *
 * A fresh cycle cuts its temporary branch first and resolves upstream after. A gate that stops the
 * run there (upstream changed its sync config, upstream needs a newer CLI, upstream is behind the
 * last sync point) drops that branch again, so the fork ends where it started and a rerun starts a
 * fresh cycle instead of shipping an empty sync branch. Full `runSyncCommand` runs, with `pnpm`
 * (install + check) stubbed and `gh` reported missing.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamConfigChangedError } from '../src/services/merge-engine';
import { runSyncCommand } from '../src/services/sync';
import { buildRuntimeConfig, createTestEnv, makeCommit, type TestEnv, tagUpstream } from './e2e/helpers/test-env';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnSync = (command: string, ...rest: unknown[]) => {
    if (command === 'pnpm') return { status: 0, stdout: '', stderr: '' };
    if (command === 'gh') return { status: 1, stdout: '', stderr: '' };
    return (actual.spawnSync as (...args: unknown[]) => unknown)(command, ...rest);
  };
  return { ...actual, spawnSync };
});

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Upstream sync config with the given pinned entries and package.json keys. */
const upstreamConfig = (pinned: string[], packageJsonSync: string[]) =>
  `export default defineConfig({\n  settings: {\n    upstreamUrl: 'x',\n` +
  `    packageJsonSync: [${packageJsonSync.map((key) => `'${key}'`).join(', ')}],\n  },\n` +
  `  overrides: {\n    pinned: [${pinned.map((entry) => `'${entry}'`).join(', ')}],\n  },\n});\n`;

describe('sync stops before the merge', () => {
  let env: TestEnv;
  let lines: string[];

  /** The fork is where it started: on `branch`, no sync branch left, nothing staged or changed. */
  function expectUntouched(branch: string, head: string): void {
    expect(exec('git rev-parse --abbrev-ref HEAD', env.forkPath)).toBe(branch);
    expect(exec('git rev-parse HEAD', env.forkPath)).toBe(head);
    expect(exec('git branch --list "cella/sync/*"', env.forkPath)).toBe('');
    expect(exec('git status --porcelain', env.forkPath)).toBe('');
    expect(fs.existsSync(path.join(env.forkPath, '.git/MERGE_HEAD'))).toBe(false);
  }

  /** Move the trunk to the committed sync branch and drop that branch, as merging its PR would. */
  function landSyncBranch(): void {
    const branch = exec('git rev-parse --abbrev-ref HEAD', env.forkPath);
    expect(branch).toMatch(/^cella\/sync\//);
    exec(`git switch -q main && git merge -q --ff-only ${branch} && git branch -q -D ${branch}`, env.forkPath);
  }

  beforeEach(() => {
    env = createTestEnv();
    // The test fork is a clone of upstream: without this its trunk tracks upstream and fast-forwards to it
    exec('git branch --unset-upstream main', env.forkPath);
    lines = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.cleanup();
  });

  describe('upstream changed its sync config', () => {
    /** Both sides share upstream's config; upstream then pins a path, syncs `exports` and adds a file. */
    function setupConfigChange(): void {
      makeCommit(env.upstreamPath, {
        files: { 'cella/cella.config.ts': upstreamConfig(['a.ts'], ['dependencies', 'devDependencies']) },
        message: 'chore: add sync config',
      });
      exec('git fetch -q cella-upstream && git merge -q --ff-only cella-upstream/main', env.forkPath);
      makeCommit(env.upstreamPath, {
        files: {
          'cella/cella.config.ts': upstreamConfig(
            ['a.ts', 'backend/src/bundle-config.ts'],
            ['dependencies', 'devDependencies', 'exports'],
          ),
          'backend/src/bundle-config.ts': 'export const bundle = [];\n',
          'README.md': '# Upstream readme\n',
        },
        message: 'feat: bundle config',
      });
    }

    it('prints what changed, stops and leaves the fork on the branch it started from', async () => {
      setupConfigChange();
      exec('git switch -q -c work', env.forkPath);
      const head = exec('git rev-parse HEAD', env.forkPath);

      const run = runSyncCommand(buildRuntimeConfig(env, { service: 'sync', pinned: ['a.ts'] }));

      await expect(run).rejects.toBeInstanceOf(UpstreamConfigChangedError);
      expectUntouched('work', head);
      expect(fs.existsSync(path.join(env.forkPath, 'backend/src/bundle-config.ts'))).toBe(false);
      const out = lines.join('\n');
      expect(out).toContain('upstream changed its sync config · 2 entries to review');
      expect(out).toContain('+ pinned: backend/src/bundle-config.ts');
      expect(out).toContain('+ packageJsonSync: exports');
      expect(out).toMatch(/removed the unused 'cella\/sync\/[\d-]+', back on 'work'\./);
    });

    it('merges with the fork config as it stands on --keep-config', async () => {
      setupConfigChange();

      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync', pinned: ['a.ts'], keepConfig: true }));

      // The path upstream now pins arrived as an ordinary synced file, and the run still reports the entries
      expect(exec('git rev-parse --abbrev-ref HEAD', env.forkPath)).toMatch(/^cella\/sync\//);
      expect(exec('git log -1 --format=%s', env.forkPath)).toMatch(/^chore: sync upstream cella/);
      expect(fs.existsSync(path.join(env.forkPath, 'backend/src/bundle-config.ts'))).toBe(true);
      expect(lines.join('\n')).toContain('+ pinned: backend/src/bundle-config.ts');
    });

    it('merges once the fork config follows upstream', async () => {
      setupConfigChange();
      const config = buildRuntimeConfig(env, { service: 'sync', pinned: ['a.ts', 'backend/src/bundle-config.ts'] });
      config.settings.packageJsonSync = ['dependencies', 'devDependencies', 'exports'];

      await runSyncCommand(config);

      expect(exec('git log -1 --format=%s', env.forkPath)).toMatch(/^chore: sync upstream cella/);
      // Pinned and absent in the fork: the file stays out
      expect(fs.existsSync(path.join(env.forkPath, 'backend/src/bundle-config.ts'))).toBe(false);
      expect(lines.join('\n')).not.toContain('upstream changed its sync config');
    });

    it('never gates the rerun that commits an already staged merge', async () => {
      setupConfigChange();
      makeCommit(env.forkPath, { files: { 'README.md': '# Fork readme\n' }, message: 'docs: fork readme' });
      const keep = buildRuntimeConfig(env, { service: 'sync', pinned: ['a.ts'], keepConfig: true });
      await runSyncCommand(keep);
      expect(exec('git diff --name-only --diff-filter=U', env.forkPath)).toBe('README.md');

      // Resolve the conflict, then rerun without the flag: the merge is staged, so the run only commits it
      fs.writeFileSync(path.join(env.forkPath, 'README.md'), '# Fork readme\n');
      exec('git add README.md', env.forkPath);
      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync', pinned: ['a.ts'] }));

      expect(exec('git log -1 --format=%s', env.forkPath)).toMatch(/^chore: sync upstream cella/);
      expect(exec('git status --porcelain', env.forkPath)).toBe('');
    });
  });

  describe('upstream is behind the last sync point', () => {
    /** A branch-tracking sync that went past the latest release (v0.1.0), landed on the trunk. */
    async function syncPastLatestRelease(): Promise<string> {
      makeCommit(env.upstreamPath, { files: { 'version.ts': 'v1\n' }, message: 'feat: v1' });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      makeCommit(env.upstreamPath, { files: { 'version.ts': 'v2\n' }, message: 'feat: v2' });
      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync', track: 'branch' }));
      landSyncBranch();
      lines.length = 0;
      return exec('git rev-parse HEAD', env.forkPath);
    }

    it('ends release tracking as a no-op with a message, back on the start branch', async () => {
      const head = await syncPastLatestRelease();

      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync', track: 'release' }));

      expectUntouched('main', head);
      expect(fs.readFileSync(path.join(env.forkPath, 'version.ts'), 'utf8')).toBe('v2\n');
      const out = lines.join('\n');
      expect(out).toContain('nothing to sync — the last sync already went past this upstream point.');
      expect(out).toMatch(/upstream v0\.1\.0 \([0-9a-f]+\) is behind the last sync point/);
      expect(out).toContain('Nothing to sync until a release past');
    });

    it('returns a detached start to its commit', async () => {
      const head = await syncPastLatestRelease();
      exec('git switch -q --detach', env.forkPath);

      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync', track: 'release' }));

      expectUntouched('HEAD', head);
    });

    it('fails for a pinned --ref behind the sync point, and still drops the branch', async () => {
      const head = await syncPastLatestRelease();

      const run = runSyncCommand(buildRuntimeConfig(env, { service: 'sync', ref: 'v0.1.0' }));

      await expect(run).rejects.toThrow(/behind the last sync point[\s\S]*Pick a newer --ref/);
      expectUntouched('main', head);
    });
  });

  it('drops the branch when upstream needs a newer CLI', async () => {
    makeCommit(env.upstreamPath, {
      files: { 'package.json': '{"name": "test-upstream", "devDependencies": {"@cellajs/cli": "^999.0.0"}}\n' },
      message: 'chore: bump cli',
    });
    const head = exec('git rev-parse HEAD', env.forkPath);

    await expect(runSyncCommand(buildRuntimeConfig(env, { service: 'sync' }))).rejects.toThrow(
      /upstream needs @cellajs\/cli \^999\.0\.0/,
    );

    expectUntouched('main', head);
  });
});
