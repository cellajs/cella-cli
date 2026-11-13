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

const { parseCli, parseToolCommand } = await import('../src/cli');

/** parseCli for a command line that names an upstream command. */
async function parseUpstream(config: CellaCliConfig, forkPath: string) {
  const parsed = await parseCli(config, forkPath);
  if ('tool' in parsed) throw new Error(`parsed the tool command ${parsed.tool.name}`);
  return parsed;
}

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

    const config = await parseUpstream(baseConfig, '/tmp/fork');

    expect(selectMock).toHaveBeenCalledOnce();
    expect(config.service).toBe('analyze');
  });

  it('parses a subcommand with additional options', async () => {
    process.argv = ['node', 'cella', 'adopt', '--fork', 'raak', '--json'];

    const config = await parseUpstream(baseConfig, '/tmp/fork');

    expect(config.service).toBe('adopt');
    expect(config.fork).toBe('raak');
    expect(config.json).toBe(true);
  });

  it('parses service-specific flags for upgrade', async () => {
    process.argv = ['node', 'cella', 'upgrade', '--track', 'branch'];

    const config = await parseUpstream(baseConfig, '/tmp/fork');

    expect(config.service).toBe('upgrade');
    expect(config.track).toBe('branch');
  });

  it('runs upgrade under its 0.5 name sync, with its options, and warns about the rename', async () => {
    process.argv = ['node', 'cella', 'sync', '--track', 'branch'];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const config = await parseUpstream(
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
    expect((await parseUpstream(baseConfig, '/tmp/fork')).ref).toBe('4f7d87c');

    process.argv = ['node', 'cella', 'analyze', '--ref', 'v0.14.0'];
    expect((await parseUpstream(baseConfig, '/tmp/fork')).ref).toBe('v0.14.0');
  });

  it('parses --keep-config for upgrade', async () => {
    process.argv = ['node', 'cella', 'upgrade'];
    expect((await parseUpstream(baseConfig, '/tmp/fork')).keepConfig).toBe(false);

    process.argv = ['node', 'cella', 'upgrade', '--ref', '4f7d87c', '--keep-config', '--unpinned'];
    const aggressive = await parseUpstream(baseConfig, '/tmp/fork');
    expect(aggressive.keepConfig).toBe(true);
    expect(aggressive.unpinned).toBe(true);
  });

  it('hands the arguments after -- to the codemod of align --run as given, and none without --', async () => {
    const id = '20261001T2116-tailwind-class-conventions';
    process.argv = ['node', 'cella', 'align', '--run', id, '--', 'rewrite', 'frontend/src', '--module', '~/app x'];

    const config = await parseUpstream(baseConfig, '/tmp/fork');

    expect(config.service).toBe('align');
    expect(config.run).toBe(id);
    expect(config.runArgs).toEqual(['rewrite', 'frontend/src', '--module', '~/app x']);

    process.argv = ['node', 'cella', 'align', '--run', id];
    expect((await parseUpstream(baseConfig, '/tmp/fork')).runArgs).toEqual([]);
  });

  it('refuses arguments after the options without --run', async () => {
    process.argv = ['node', 'cella', 'align', '--', 'rewrite', 'frontend/src'];
    await expect(parseCli(baseConfig, '/tmp/fork')).rejects.toThrow(/unexpected argument 'rewrite'.*--run <id>/);

    process.argv = ['node', 'cella', 'align', '--mark', '20261002T0614-config-switch'];
    const config = await parseUpstream(baseConfig, '/tmp/fork');
    expect(config.mark).toEqual(['20261002T0614-config-switch']);
    expect(config.runArgs).toBeUndefined();
  });
});

describe('parseToolCommand', () => {
  it('takes the job before -- and hands the words after it to testbed as the command to run', () => {
    const parse = (...args: string[]) => parseToolCommand(['node', 'cella', ...args])?.options;

    expect(parse('testbed')).toEqual({ job: 'start', fresh: false, showcase: false, command: [] });
    expect(parse('testbed', 'stop')).toEqual({ job: 'stop', fresh: false, showcase: false, command: [] });
    expect(parse('testbed', '--fresh', '--', 'pnpm', 'a11y', '--states', 'stop')).toEqual({
      job: 'start',
      fresh: true,
      showcase: false,
      command: ['pnpm', 'a11y', '--states', 'stop'],
    });
    expect(parse('testbed', '--showcase')).toEqual({ job: 'start', fresh: false, showcase: true, command: [] });
    expect(() => parse('testbed', 'pnpm', 'a11y')).toThrow(/unexpected argument 'a11y'/);
    expect(() => parse('testbed', 'restart')).toThrow(/unknown job 'restart'/);
    expect(parse('analyze')).toBeUndefined();
  });

  it('takes shot ids as operands, and refuses an a11y flag given to another job', () => {
    const parse = (...args: string[]) => parseToolCommand(['node', 'cella', ...args])?.options;

    expect(parse('shoot', 'settings', 'org-page', '--out', '/tmp/shots')).toEqual({
      ids: ['settings', 'org-page'],
      out: '/tmp/shots',
      email: undefined,
    });
    expect(parse('a11y', '--states', 'sign-in,home')).toEqual({
      job: 'audit',
      audit: { states: ['sign-in', 'home'], workers: 4, email: undefined },
    });
    expect(() => parse('a11y', 'report', '--states', 'home')).toThrow(/--states goes with `a11y audit`/);
  });

  it('parses the branch mode of stats, which needs no cella.config.ts', () => {
    const parse = (...args: string[]) => parseToolCommand(['node', 'cella', ...args])?.options;

    expect(parse('stats', '--since', 'origin/main', '--md')).toEqual({
      since: 'origin/main',
      md: true,
      verbose: false,
    });
    expect(parse('stats')).toEqual({ since: undefined, md: false, verbose: false });
    expect(() => parse('stats', '--md')).toThrow(/--md goes with --since <ref>/);
  });
});
