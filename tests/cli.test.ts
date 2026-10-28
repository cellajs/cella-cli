import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellaCliConfig } from '../src/config/types';

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  select: selectMock,
}));

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(() => '{"name":"my-app"}'),
}));

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

vi.mock('../src/utils/display', () => ({
  MENU_DIVIDER: '─'.repeat(40),
  VERSION: 'test',
  printHeader: vi.fn(),
  setJsonMode: vi.fn(),
  warningMark: '⚠',
}));

const { parseCli } = await import('../src/cli');

const baseConfig: CellaCliConfig = {
  settings: {
    upstreamUrl: 'git@github.com:cellajs/cella.git',
    upstreamBranch: 'main',
  },
};

describe('parseCli', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    selectMock.mockReset();
    readFileSyncMock.mockClear();
    vi.restoreAllMocks();
  });

  it('prompts for a service when no arguments are provided', async () => {
    process.argv = ['node', 'cella'];
    selectMock.mockResolvedValue('analyze');

    const config = await parseCli(baseConfig, '/tmp/fork');

    expect(selectMock).toHaveBeenCalledOnce();
    expect(config.service).toBe('analyze');
  });

  it('parses a subcommand with additional options', async () => {
    process.argv = ['node', 'cella', 'contributions', '--fork', 'raak', '--json'];

    const config = await parseCli(baseConfig, '/tmp/fork');

    expect(config.service).toBe('contributions');
    expect(config.fork).toBe('raak');
    expect(config.json).toBe(true);
  });

  it('parses service-specific flags for upgrade', async () => {
    process.argv = ['node', 'cella', 'upgrade', '--track', 'branch'];

    const config = await parseCli(baseConfig, '/tmp/fork');

    expect(config.service).toBe('upgrade');
    expect(config.track).toBe('branch');
  });

  it('runs upgrade under its 0.5 name sync, with its options, and warns about the rename', async () => {
    process.argv = ['node', 'cella', 'sync', '--track', 'branch'];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const config = await parseCli(
      { ...baseConfig, settings: { ...baseConfig.settings, syncWithPackages: true } },
      '/tmp/fork',
    );

    expect(config.service).toBe('upgrade');
    expect(config.track).toBe('branch');
    const out = info.mock.calls.flat().join('\n');
    expect(out).toContain('`cella sync` is renamed to `cella upgrade`');
    expect(out).toContain('settings.syncWithPackages is renamed to mergePackageJson');
  });

  it('parses a pinned upstream ref for upgrade and analyze', async () => {
    process.argv = ['node', 'cella', 'upgrade', '--ref', '4f7d87c'];
    expect((await parseCli(baseConfig, '/tmp/fork')).ref).toBe('4f7d87c');

    process.argv = ['node', 'cella', 'analyze', '--ref', 'v0.14.0'];
    expect((await parseCli(baseConfig, '/tmp/fork')).ref).toBe('v0.14.0');
  });

  it('parses --keep-config for upgrade and forks', async () => {
    process.argv = ['node', 'cella', 'upgrade'];
    expect((await parseCli(baseConfig, '/tmp/fork')).keepConfig).toBe(false);

    process.argv = ['node', 'cella', 'upgrade', '--ref', '4f7d87c', '--keep-config', '--unpinned'];
    const aggressive = await parseCli(baseConfig, '/tmp/fork');
    expect(aggressive.keepConfig).toBe(true);
    expect(aggressive.unpinned).toBe(true);

    process.argv = ['node', 'cella', 'forks', '--fork', 'raak', '--keep-config'];
    expect((await parseCli(baseConfig, '/tmp/fork')).keepConfig).toBe(true);
  });

  it('hands the arguments after -- to the codemod of align --run as given, and none without --', async () => {
    const id = '20261001T2116-tailwind-class-conventions';
    process.argv = ['node', 'cella', 'align', '--run', id, '--', 'rewrite', 'frontend/src', '--module', '~/app x'];

    const config = await parseCli(baseConfig, '/tmp/fork');

    expect(config.service).toBe('align');
    expect(config.run).toBe(id);
    expect(config.runArgs).toEqual(['rewrite', 'frontend/src', '--module', '~/app x']);

    process.argv = ['node', 'cella', 'align', '--run', id];
    expect((await parseCli(baseConfig, '/tmp/fork')).runArgs).toEqual([]);
  });

  it('parses the branch mode of stats', async () => {
    process.argv = ['node', 'cella', 'stats', '--since', 'origin/main', '--md'];
    const branch = await parseCli(baseConfig, '/tmp/fork');
    expect(branch).toMatchObject({ service: 'stats', since: 'origin/main', md: true });

    process.argv = ['node', 'cella', 'stats'];
    const snapshot = await parseCli(baseConfig, '/tmp/fork');
    expect(snapshot.since).toBeUndefined();
    expect(snapshot.md).toBe(false);
  });

  it('refuses arguments after the options without --run', async () => {
    process.argv = ['node', 'cella', 'align', '--', 'rewrite', 'frontend/src'];
    await expect(parseCli(baseConfig, '/tmp/fork')).rejects.toThrow(/unexpected argument 'rewrite'.*--run <id>/);

    process.argv = ['node', 'cella', 'align', '--mark', '20261002T0614-config-switch'];
    const config = await parseCli(baseConfig, '/tmp/fork');
    expect(config.mark).toEqual(['20261002T0614-config-switch']);
    expect(config.runArgs).toBeUndefined();
  });
});
