/**
 * Tests for `cella upgrade` runs that stop before the merge or have nothing to commit.
 *
 * A fresh cycle cuts its temporary branch first and resolves upstream after. A gate that stops the
 * run there (upstream changed its CLI config, upstream needs a newer CLI, upstream is behind the
 * last upgrade point) drops that branch again, so the app ends where it started and a rerun starts a
 * fresh cycle instead of shipping an empty upgrade branch. A run with nothing upstream to merge, and
 * a rerun that finds a merge an earlier run never finished, end the same way. Full
 * `runUpgradeCommand` runs, with `pnpm` (install + check) stubbed and `gh` reported missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamConfigChangedError } from '../../src/upstream/merge-engine';
import { runUpgradeCommand } from '../../src/upstream/upgrade';
import { buildRuntimeConfig, createTestEnv, exec, makeCommit, type TestEnv, tagUpstream } from '../helpers/test-env';

vi.mock('node:child_process', async (importOriginal) => {
  const { mockPnpmAndGh } = await import('../helpers/mock-pnpm-gh');
  return mockPnpmAndGh(await importOriginal<typeof import('node:child_process')>());
});

/** Upstream upgrade config with the given pinned entries and package.json keys. */
const upstreamConfig = (pinned: string[], packageJsonKeys: string[]) =>
  `export default defineConfig({\n  upstreamUrl: 'x',\n` +
  `  packageJsonKeys: [${packageJsonKeys.map((key) => `'${key}'`).join(', ')}],\n` +
  `  pinned: [${pinned.map((entry) => `'${entry}'`).join(', ')}],\n});\n`;

describe('upgrade stops before the merge', () => {
  let env: TestEnv;
  let lines: string[];

  /** The app is where it started: on `branch`, no upgrade branch left, nothing staged or changed. */
  function expectUntouched(branch: string, head: string): void {
    expect(exec('git rev-parse --abbrev-ref HEAD', env.repoRoot)).toBe(branch);
    expect(exec('git rev-parse HEAD', env.repoRoot)).toBe(head);
    expect(exec('git branch --list "cella/upgrade/*"', env.repoRoot)).toBe('');
    expect(exec('git status --porcelain', env.repoRoot)).toBe('');
    expect(fs.existsSync(path.join(env.repoRoot, '.git/MERGE_HEAD'))).toBe(false);
  }

  /** Move the trunk to the committed upgrade branch and drop that branch, as merging its PR would. */
  function landUpgradeBranch(): void {
    const branch = exec('git rev-parse --abbrev-ref HEAD', env.repoRoot);
    expect(branch).toMatch(/^cella\/upgrade\//);
    exec(`git switch -q main && git merge -q --ff-only ${branch} && git branch -q -D ${branch}`, env.repoRoot);
  }

  beforeEach(() => {
    env = createTestEnv();
    // The test app is a clone of upstream: without this its trunk tracks upstream and fast-forwards to it
    exec('git branch --unset-upstream main', env.repoRoot);
    lines = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.cleanup();
  });

  describe('upstream changed its CLI config', () => {
    /** Both sides share upstream's config; upstream then pins a path, upgrades `exports` and adds a file. */
    function setupConfigChange(): void {
      makeCommit(env.upstreamPath, {
        files: { 'cella/cella.config.ts': upstreamConfig(['a.ts'], ['dependencies', 'devDependencies']) },
        message: 'chore: add upgrade config',
      });
      exec('git fetch -q cella-upstream && git merge -q --ff-only cella-upstream/main', env.repoRoot);
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

    it('prints what changed, stops and leaves the app on the branch it started from', async () => {
      setupConfigChange();
      exec('git switch -q -c work', env.repoRoot);
      const head = exec('git rev-parse HEAD', env.repoRoot);

      const config = buildRuntimeConfig(env, { pinned: ['a.ts'] });
      const stop = await runUpgradeCommand(config).catch((error: unknown) => error);

      expect(stop).toBeInstanceOf(UpstreamConfigChangedError);
      expect((stop as UpstreamConfigChangedError).report).toMatchObject({
        type: 'changes',
        pinned: { added: ['backend/src/bundle-config.ts'], removed: [] },
      });
      expect((stop as Error).message).toMatch(
        /stopped before the merge, nothing changed[\s\S]*rerun with --keep-config/,
      );
      expectUntouched('work', head);
      expect(fs.existsSync(path.join(env.repoRoot, 'backend/src/bundle-config.ts'))).toBe(false);
      const out = lines.join('\n');
      expect(out).toContain('upstream changed its CLI config · 2 entries to review');
      expect(out).toContain('+ pinned: backend/src/bundle-config.ts');
      expect(out).toContain('+ packageJsonKeys: exports');
      expect(out).toMatch(/removed the unused 'cella\/upgrade\/[\d-]+', back on 'work'\./);
    });

    it('merges with the app config as it stands on --keep-config', async () => {
      setupConfigChange();

      await runUpgradeCommand(buildRuntimeConfig(env, { pinned: ['a.ts'], keepConfig: true }));

      // The path upstream now pins arrived as an ordinary merged file, and the run still reports the entries
      expect(exec('git rev-parse --abbrev-ref HEAD', env.repoRoot)).toMatch(/^cella\/upgrade\//);
      expect(exec('git log -1 --format=%s', env.repoRoot)).toMatch(/^chore: upgrade cella to/);
      expect(fs.existsSync(path.join(env.repoRoot, 'backend/src/bundle-config.ts'))).toBe(true);
      expect(lines.join('\n')).toContain('+ pinned: backend/src/bundle-config.ts');
    });

    it('merges once the app config follows upstream', async () => {
      setupConfigChange();
      const config = buildRuntimeConfig(env, { pinned: ['a.ts', 'backend/src/bundle-config.ts'] });
      config.packageJsonKeys = ['dependencies', 'devDependencies', 'exports'];

      await runUpgradeCommand(config);

      expect(exec('git log -1 --format=%s', env.repoRoot)).toMatch(/^chore: upgrade cella to/);
      // Pinned before it exists, as an alignment can ask: upstream's copy arrives as the app's first one
      expect(fs.existsSync(path.join(env.repoRoot, 'backend/src/bundle-config.ts'))).toBe(true);
      expect(lines.join('\n')).not.toContain('upstream changed its CLI config');
    });

    it('never gates the rerun that commits an already staged merge', async () => {
      setupConfigChange();
      makeCommit(env.repoRoot, { files: { 'README.md': '# App readme\n' }, message: 'docs: app readme' });
      const keep = buildRuntimeConfig(env, { pinned: ['a.ts'], keepConfig: true });
      await runUpgradeCommand(keep);
      expect(exec('git diff --name-only --diff-filter=U', env.repoRoot)).toBe('README.md');

      // Resolve the conflict, then rerun without the flag: the merge is staged, so the run only commits it
      fs.writeFileSync(path.join(env.repoRoot, 'README.md'), '# App readme\n');
      exec('git add README.md', env.repoRoot);
      await runUpgradeCommand(buildRuntimeConfig(env, { pinned: ['a.ts'] }));

      expect(exec('git log -1 --format=%s', env.repoRoot)).toMatch(/^chore: upgrade cella to/);
      expect(exec('git status --porcelain', env.repoRoot)).toBe('');
    });
  });

  describe('upstream is behind the last upgrade point', () => {
    /** A branch-tracking upgrade that went past the latest release (v0.1.0), landed on the trunk. */
    async function upgradePastLatestRelease(): Promise<string> {
      makeCommit(env.upstreamPath, { files: { 'version.ts': 'v1\n' }, message: 'feat: v1' });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      makeCommit(env.upstreamPath, { files: { 'version.ts': 'v2\n' }, message: 'feat: v2' });
      await runUpgradeCommand(buildRuntimeConfig(env, { track: 'branch' }));
      landUpgradeBranch();
      lines.length = 0;
      return exec('git rev-parse HEAD', env.repoRoot);
    }

    it('ends release tracking as a no-op with a message, back on the start branch', async () => {
      const head = await upgradePastLatestRelease();

      await runUpgradeCommand(buildRuntimeConfig(env, { track: 'release' }));

      expectUntouched('main', head);
      expect(fs.readFileSync(path.join(env.repoRoot, 'version.ts'), 'utf8')).toBe('v2\n');
      const out = lines.join('\n');
      expect(out).toContain('nothing to upgrade: the last upgrade already went past this upstream point.');
      expect(out).toMatch(/upstream v0\.1\.0 \([0-9a-f]+\) is behind the last upgrade at/);
      expect(out).toContain('Nothing to upgrade until a release past');
    });

    it('returns a detached start to its commit', async () => {
      const head = await upgradePastLatestRelease();
      exec('git switch -q --detach', env.repoRoot);

      await runUpgradeCommand(buildRuntimeConfig(env, { track: 'release' }));

      expectUntouched('HEAD', head);
    });

    it('fails for a pinned --ref behind the upgrade point, and still drops the branch', async () => {
      const head = await upgradePastLatestRelease();

      const run = runUpgradeCommand(buildRuntimeConfig(env, { ref: 'v0.1.0' }));

      await expect(run).rejects.toThrow(/behind the last upgrade at[\s\S]*Pick a newer --ref/);
      expectUntouched('main', head);
    });
  });

  it('leaves an app whose only change since the last upgrade is in an ignored path where it started', async () => {
    const config = buildRuntimeConfig(env, { ignored: ['docs'] });
    makeCommit(env.upstreamPath, { files: { 'feature.ts': 'export const f = 1;\n' }, message: 'feat: feature' });
    await runUpgradeCommand(config);
    landUpgradeBranch();
    const head = makeCommit(env.repoRoot, { files: { 'docs/guide.md': '# App guide\n' }, message: 'docs: app guide' });

    await runUpgradeCommand(config);

    expectUntouched('main', head);
  });

  it('never commits a merge on an upgrade branch that the engine did not finish', async () => {
    makeCommit(env.upstreamPath, { files: { 'feature.ts': 'export const f = 1;\n' }, message: 'feat: feature' });
    const head = exec('git rev-parse HEAD', env.repoRoot);
    // A run stopped right after the merge: protected files not yet restored and no upgrade recorded
    exec('git switch -q -c cella/upgrade/20260101-0000', env.repoRoot);
    exec('git fetch -q cella-upstream && git merge -q --no-ff --no-commit cella-upstream/main', env.repoRoot);

    await runUpgradeCommand(buildRuntimeConfig(env));

    expectUntouched('main', head);
    expect(lines.join('\n')).toContain("stopped before it finished the merge on 'cella/upgrade/20260101-0000'");
  });

  it('drops the branch when upstream needs a newer CLI', async () => {
    makeCommit(env.upstreamPath, {
      files: { 'package.json': '{"name": "test-upstream", "devDependencies": {"@cellajs/cli": "^999.0.0"}}\n' },
      message: 'chore: bump cli',
    });
    const head = exec('git rev-parse HEAD', env.repoRoot);

    await expect(runUpgradeCommand(buildRuntimeConfig(env))).rejects.toThrow(
      /upstream needs @cellajs\/cli \^999\.0\.0/,
    );

    expectUntouched('main', head);
  });
});
