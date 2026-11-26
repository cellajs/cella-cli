import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { CommanderError } from 'commander';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
}));

vi.mock('@inquirer/select', () => ({
  default: selectMock,
}));

const { parseCommandLine, promptForCommand } = await import('../src/cli');

/** The options `cella <args>` parses into. */
const parse = (...args: string[]) => parseCommandLine(['node', 'cella', ...args])?.options;

describe('parseCommandLine', () => {
  const terminal = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
  const setTerminal = (isTTY: boolean) => {
    Object.assign(process.stdin, { isTTY });
    Object.assign(process.stdout, { isTTY });
  };

  afterEach(() => {
    Object.assign(process.stdin, { isTTY: terminal.stdin });
    Object.assign(process.stdout, { isTTY: terminal.stdout });
    vi.restoreAllMocks();
  });

  it('leaves a bare cella in a terminal to the menu, and prints the help without one', () => {
    setTerminal(true);
    expect(parseCommandLine(['node', 'cella'])).toBeUndefined();

    setTerminal(false);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(() => parseCommandLine(['node', 'cella'])).toThrow(CommanderError);
    expect(write.mock.calls.join('')).toContain('Usage: cella');
  });

  it('parses the options of the upstream commands, each into its own shape', () => {
    expect(parse('adopt', '--fork', 'raak', '--json')).toEqual({ fork: 'raak', json: true });
    expect(parse('upgrade', '--ref', '4f7d87c', '--keep-config', '--unpinned')).toEqual({
      track: undefined,
      ref: '4f7d87c',
      keepConfig: true,
      unpinned: true,
    });
    expect(parse('analyze', '--track', 'branch', '--ref', 'v0.14.0')).toMatchObject({
      track: 'branch',
      ref: 'v0.14.0',
    });
    expect(() => parse('upgrade', '--track', 'tip')).toThrow(/invalid --track 'tip'/);
  });

  it('switches to machine output on the options a command declares for it', () => {
    const machine = (...args: string[]) => parseCommandLine(['node', 'cella', ...args])?.machineOutput;
    expect(machine('analyze', '--list')).toBe(true);
    expect(machine('analyze')).toBe(false);
    expect(machine('align', '--json')).toBe(true);
    expect(machine('stats', '--since', 'origin/main', '--md')).toBe(true);
  });

  it('takes an align job, and hands the words after -- to the codemod of run alone', () => {
    const id = '20261001T2116-tailwind-class-conventions';
    expect(parse('align')).toEqual({ job: 'list', all: false, json: false });
    expect(parse('align', 'run', id, '--', 'rewrite', 'frontend/src', '--module', '~/app x')).toEqual({
      job: 'run',
      id,
      codemodArgs: ['rewrite', 'frontend/src', '--module', '~/app x'],
    });
    expect(parse('align', 'run', id)).toEqual({ job: 'run', id, codemodArgs: [] });
    expect(parse('align', 'mark', id, 'other')).toEqual({ job: 'mark', ids: [id, 'other'] });
    expect(() => parse('align', '--', 'rewrite')).toThrow(/only `align run <id>` takes arguments after --/);
    expect(() => parse('align', 'show', id, '--all')).toThrow(/--all goes with `align list`/);
    expect(() => parse('align', 'show')).toThrow(/show takes one alignment id/);
  });

  it('takes the job before -- and hands the words after it to testbed as the command to run', () => {
    expect(parse('testbed')).toEqual({ job: 'start', fresh: false, showcase: false, command: [] });
    expect(parse('testbed', 'stop')).toEqual({ job: 'stop', fresh: false, showcase: false, command: [] });
    expect(parse('testbed', '--fresh', '--', 'pnpm', 'a11y', '--states', 'stop')).toEqual({
      job: 'start',
      fresh: true,
      showcase: false,
      command: ['pnpm', 'a11y', '--states', 'stop'],
    });
    // A help flag after `--` is the command's own
    expect(parse('testbed', '--', 'node', 'script.mjs', '--help')).toMatchObject({
      command: ['node', 'script.mjs', '--help'],
    });
    expect(() => parse('testbed', 'pnpm', 'a11y')).toThrow(/unexpected argument 'a11y'/);
    expect(() => parse('testbed', 'restart')).toThrow(/unknown job 'restart'/);
    expect(() => parse('testbed', 'stop', '--fresh')).toThrow(/--fresh goes with `testbed start`/);
  });

  it('takes shot ids as operands, and refuses an a11y flag given to another job', () => {
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

  it('hands every word after infra to the infra CLI as typed, its help included', () => {
    expect(parse('infra', 'apply', '--mode', 'production', '--once')).toEqual({
      words: ['apply', '--mode', 'production', '--once'],
    });
    expect(parse('infra', '--help')).toEqual({ words: ['--help'] });
    expect(parse('infra', 'status', '--json')).toEqual({ words: ['status', '--json'] });
    expect(parse('infra')).toEqual({ words: [] });
  });

  it('reports with a bare audit and writes with audit fix', () => {
    expect(parse('audit')).toBe('report');
    expect(parse('audit', 'fix')).toBe('fix');
    expect(parse('stats', '--since', 'origin/main', '--md')).toEqual({
      since: 'origin/main',
      md: true,
      verbose: false,
    });
    expect(() => parse('stats', '--md')).toThrow(/--md goes with --since <ref>/);
  });
});

describe('promptForCommand', () => {
  afterEach(() => selectMock.mockReset());

  const offered = () => selectMock.mock.calls[0][0].choices.map((choice: { value?: string }) => choice.value);

  it('offers what the app allows, and asks for a job only among the ones that run without words', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    selectMock.mockResolvedValueOnce('align');
    expect((await promptForCommand({ hasForks: false, isUpstreamRepo: false, hasInfra: false })).options).toEqual({
      job: 'list',
      all: false,
      json: false,
    });
    expect(selectMock).toHaveBeenCalledOnce();
    expect(offered()).toContain('analyze');
    expect(offered()).not.toContain('adopt');
    expect(offered()).not.toContain('testbed');
    expect(offered()).not.toContain('style');
    expect(offered()).not.toContain('infra');

    selectMock.mockReset();
    selectMock.mockResolvedValueOnce('audit').mockResolvedValueOnce('fix');
    expect((await promptForCommand({ hasForks: true, isUpstreamRepo: true, hasInfra: true })).options).toBe('fix');
    expect(offered()).toContain('adopt');
    expect(offered()).toContain('infra');
    expect(offered()).not.toContain('analyze');
  });
});

describe('the menu list', () => {
  const src = resolve(__dirname, '../src');
  const localImports = (file: string) =>
    [...readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)].map(([, path]) => resolve(dirname(file), `${path}.ts`));

  // Every engine run loads what the list loads: the engine or the package header there would load with it
  it('is the one the engine imports, and loads nothing of the engine or the package header', () => {
    const menu = join(src, 'utils/menu.ts');
    expect(localImports(join(src, 'infra/cli/infra-cli.ts'))).toContain(menu);
    const loaded = new Set([menu]);
    for (const file of loaded) for (const imported of localImports(file)) loaded.add(imported);
    expect([...loaded].filter((file) => file.includes('/infra/') || file.endsWith('/display.ts'))).toEqual([]);
  });
});

describe('exit codes', () => {
  const cli = resolve(__dirname, '..');
  const plain = mkdtempSync(join(tmpdir(), 'cella-cli-plain-'));
  const repo = mkdtempSync(join(tmpdir(), 'cella-cli-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'cella'));
  writeFileSync(join(repo, 'cella/cella.config.ts'), "export default { upstreamUrl: 'upstream.git' };\n");
  afterAll(() => {
    rmSync(plain, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  /** Scripts and CI read these: 0 done, 1 a check failed or a person must act, 2 a usage or runtime error. */
  it.each([
    ['--help', 0, plain, ['--help']],
    ['a bad flag', 2, repo, ['stats', '--nope']],
    ['an unknown job', 2, repo, ['testbed', 'restart']],
    ['a command outside a git repository', 2, plain, ['stats']],
    ['an adopt with no forks to adopt from', 1, repo, ['adopt']],
    ['an infra in an app without an infra workspace', 2, repo, ['infra', 'status']],
  ])('%s exits %i', (_, code, cwd, args) => {
    const run = spawnSync(join(cli, 'node_modules/.bin/tsx'), [join(cli, 'index.ts'), ...args], { cwd });
    expect(run.status).toBe(code);
  });
});
