/**
 * E2E tests for `cella migrate --run <id>`: the note's codemod runs from its extracted copy with
 * `tsx`, and files that were identical to the last synced upstream commit get their upstream
 * content back when the codemod changed them.
 *
 * `pnpm exec tsx` is replaced by this repo's own `tsx` (the temp fork has no node_modules), so the
 * codemod really runs, from the fork root, with the arguments the service hands it.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrate } from '../../src/services/migrate';
import { runSync } from '../../src/services/sync';
import { commitSquash, stageAll } from '../../src/utils/git';
import {
  buildRuntimeConfig,
  createTestEnv,
  fetchUpstream,
  makeCommit,
  readRepoFile,
  type TestEnv,
} from '../helpers/test-env';

/** Every `pnpm exec tsx` the service spawned: where, and with which arguments. */
const { codemodRuns } = vi.hoisted(() => ({ codemodRuns: [] as Array<{ cwd: string; args: string[] }> }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { resolve } = await import('node:path');
  const tsx = resolve(__dirname, '../../node_modules/.bin/tsx');
  const spawnSync = (command: string, args: string[], options: { cwd: string }) => {
    if (command !== 'pnpm' || args[0] !== 'exec' || args[1] !== 'tsx') return actual.spawnSync(command, args, options);
    codemodRuns.push({ cwd: options.cwd, args: args.slice(2) });
    return actual.spawnSync(tsx, args.slice(2), { cwd: options.cwd, encoding: 'utf8', stdio: 'pipe' });
  };
  return { ...actual, spawnSync };
});

const NOTE = '20261001T2116-icon-classes';
const MANUAL = '20261002T0000-manual-note';
const TWO_SCRIPTS = '20261003T0000-two-scripts';
const EXTRACTED = `node_modules/.cache/cella/migrations/${NOTE}/icon-classes.ts`;

const readme = (title: string, roots?: string) =>
  `---\nsyncBreaking: true\nclientCacheBump: false\n${roots ? `roots: ${roots}\n` : ''}---\n\n# ${title}\n\nWhat the app changes.\n`;

/**
 * A codemod in the shape upstream ships: `<inventory|rewrite> <roots…>`, here turning `icon-xs`
 * into `size-3`. `crash` rewrites, deletes a file and exits 3, like a codemod that fails halfway.
 */
const CODEMOD = `import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Mode = 'inventory' | 'rewrite' | 'crash';
const [mode, ...roots] = process.argv.slice(2) as [Mode, ...string[]];
if (!['inventory', 'rewrite', 'crash'].includes(mode)) {
  console.error('Usage: <inventory|rewrite> <roots…>');
  process.exit(1);
}

const list = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return list(full);
    return full.endsWith('.ts') ? [full] : [];
  });

let count = 0;
for (const file of roots.flatMap(list)) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('icon-xs')) continue;
  count++;
  if (mode !== 'inventory') writeFileSync(file, text.replaceAll('icon-xs', 'size-3'));
}
if (mode === 'crash') {
  rmSync('frontend/src/removed.ts');
  process.exit(3);
}
console.log(\`\${mode}: \${count} file(s)\`);
`;

describe('migrate --run e2e', () => {
  let env: TestEnv;
  let lines: string[];
  let upstreamCommit: string;

  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: env.forkPath, encoding: 'utf8' }).trim();
  const run = (options: { run: string; runArgs?: string[]; script?: string }) =>
    runMigrate({ ...buildRuntimeConfig(env, { service: 'migrate' }), ...options });

  /**
   * The app has its own file and its own edit of a template file. Upstream then ships the notes,
   * plus template files that still hold the class the codemod rewrites: upstream changed them
   * after writing the codemod. The sync that brings those in is staged, not committed.
   */
  beforeEach(async () => {
    env = createTestEnv();
    codemodRuns.length = 0;
    lines = [];

    makeCommit(env.upstreamPath, {
      files: { 'frontend/src/shared.ts': 'export const shared = "icon-xs";\n' },
      message: 'feat: shared',
    });
    fetchUpstream(env.forkPath);
    git('merge -q --ff-only cella-upstream/main');
    makeCommit(env.forkPath, {
      files: {
        'frontend/src/app-only.ts': 'export const mine = "icon-xs";\n',
        'frontend/src/shared.ts': 'export const shared = "icon-xs app";\n',
      },
      message: 'feat: app files',
    });

    upstreamCommit = makeCommit(env.upstreamPath, {
      files: {
        'frontend/src/template.ts': 'export const template = "icon-xs";\n',
        'frontend/src/removed.ts': 'export const removed = "icon-xs";\n',
        'backend/src/template.ts': 'export const backend = "icon-xs";\n',
        'mcp/src/[id].ts': 'export const route = "icon-xs";\n',
        'mcp/src/i.ts': 'export const index = "icon-xs";\n',
        [`cella/migrations/${NOTE}/README.md`]: readme('Icon classes', 'frontend/src'),
        [`cella/migrations/${NOTE}/icon-classes.ts`]: CODEMOD,
        [`cella/migrations/${NOTE}/icon-classes.test.ts`]: 'export {};\n',
        [`cella/migrations/${MANUAL}/README.md`]: readme('Manual note'),
        [`cella/migrations/${TWO_SCRIPTS}/README.md`]: readme('Two scripts', 'frontend/src'),
        [`cella/migrations/${TWO_SCRIPTS}/icon-classes.ts`]: CODEMOD,
        [`cella/migrations/${TWO_SCRIPTS}/lib.ts`]: 'export const lib = 1;\n',
      },
      message: 'feat: notes and template files',
    });
    fetchUpstream(env.forkPath);

    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    await runSync(buildRuntimeConfig(env, { service: 'sync' }));
    lines.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.cleanup();
  });

  it('passes the arguments after -- as given, rewrites app files and restores files identical to upstream', async () => {
    await run({ run: NOTE, runArgs: ['rewrite', 'frontend/src'] });

    expect(codemodRuns).toEqual([{ cwd: env.forkPath, args: [EXTRACTED, 'rewrite', 'frontend/src'] }]);
    // App-owned content is rewritten
    expect(readRepoFile(env.forkPath, 'frontend/src/app-only.ts')).toBe('export const mine = "size-3";\n');
    expect(readRepoFile(env.forkPath, 'frontend/src/shared.ts')).toBe('export const shared = "size-3 app";\n');
    // Template files identical to the incoming upstream commit keep upstream's content
    expect(readRepoFile(env.forkPath, 'frontend/src/template.ts')).toBe('export const template = "icon-xs";\n');
    expect(readRepoFile(env.forkPath, 'frontend/src/removed.ts')).toBe('export const removed = "icon-xs";\n');
    expect(git(`diff --name-only ${upstreamCommit} -- frontend/src/template.ts frontend/src/removed.ts`)).toBe('');

    const out = lines.join('\n');
    expect(out).toContain(`restored 2 file(s) to upstream ${upstreamCommit.slice(0, 9)}`);
    expect(out).toContain('    frontend/src/removed.ts');
    expect(out).toContain('    frontend/src/template.ts');
    expect(out).not.toContain('frontend/src/app-only.ts');
  });

  it('measures against the committed sync point once the sync is committed', async () => {
    await stageAll(env.forkPath);
    await commitSquash(env.forkPath, 'chore: sync upstream cella');
    makeCommit(env.forkPath, {
      files: { 'frontend/src/template.ts': 'export const template = "icon-xs app";\n' },
      message: 'feat: app edit of a template file',
    });

    await run({ run: NOTE, runArgs: ['rewrite', 'frontend/src'] });

    // No longer identical to upstream: the app owns the edit, so the rewrite stays
    expect(readRepoFile(env.forkPath, 'frontend/src/template.ts')).toBe('export const template = "size-3 app";\n');
    expect(readRepoFile(env.forkPath, 'frontend/src/removed.ts')).toBe('export const removed = "icon-xs";\n');
    expect(lines.join('\n')).toContain(`restored 1 file(s) to upstream ${upstreamCommit.slice(0, 9)}`);
  });

  it('covers the roots named after --, whichever they are', async () => {
    await run({ run: NOTE, runArgs: ['rewrite', 'backend/src'] });

    expect(readRepoFile(env.forkPath, 'backend/src/template.ts')).toBe('export const backend = "icon-xs";\n');
    expect(lines.join('\n')).toContain('restored 1 file(s)');
  });

  it("defaults to a report-only run over the note's roots", async () => {
    await run({ run: NOTE });

    expect(codemodRuns[0].args).toEqual([EXTRACTED, 'inventory', 'frontend/src']);
    expect(readRepoFile(env.forkPath, 'frontend/src/app-only.ts')).toBe('export const mine = "icon-xs";\n');
    const out = lines.join('\n');
    expect(out).toContain(`no file identical to upstream ${upstreamCommit.slice(0, 9)} was changed`);
    expect(out).toContain(`report only. to apply: pnpm cella migrate --run ${NOTE} -- rewrite frontend/src`);
  });

  it('restores what a failing codemod changed or deleted, then fails', async () => {
    await expect(run({ run: NOTE, runArgs: ['crash', 'frontend/src'] })).rejects.toThrow(
      'the codemod exited with code 3',
    );

    expect(readRepoFile(env.forkPath, 'frontend/src/template.ts')).toBe('export const template = "icon-xs";\n');
    expect(readRepoFile(env.forkPath, 'frontend/src/removed.ts')).toBe('export const removed = "icon-xs";\n');
    expect(lines.join('\n')).toContain('restored 2 file(s)');
  });

  it('refuses a note without a script, or with several unless one is named', async () => {
    await expect(run({ run: MANUAL })).rejects.toThrow(
      `migration note '${MANUAL}' ships no codemod script: its steps are manual`,
    );
    await expect(run({ run: TWO_SCRIPTS })).rejects.toThrow(
      `migration note '${TWO_SCRIPTS}' ships 2 scripts (icon-classes.ts, lib.ts): name the one to run with --script <file>.`,
    );
    await expect(run({ run: TWO_SCRIPTS, script: 'nope.ts' })).rejects.toThrow(
      `migration note '${TWO_SCRIPTS}' has no file 'nope.ts'`,
    );
    await expect(run({ run: '20260101T0000-unknown' })).rejects.toThrow(/no migration note/);
    expect(codemodRuns).toEqual([]);

    await run({ run: TWO_SCRIPTS, script: 'icon-classes.ts', runArgs: ['inventory', 'frontend/src'] });
    expect(codemodRuns[0].args[0]).toBe(`node_modules/.cache/cella/migrations/${TWO_SCRIPTS}/icon-classes.ts`);
  });

  it('restores a file whose name holds glob characters, and only that file', async () => {
    // As a pattern, `[id].ts` also names `i.ts`, which the app changed: its rewrite has to stay
    fs.writeFileSync(path.join(env.forkPath, 'mcp/src/i.ts'), 'export const index = "icon-xs app";\n');

    await run({ run: NOTE, runArgs: ['rewrite', 'mcp/src'] });

    expect(readRepoFile(env.forkPath, 'mcp/src/[id].ts')).toBe('export const route = "icon-xs";\n');
    expect(readRepoFile(env.forkPath, 'mcp/src/i.ts')).toBe('export const index = "size-3 app";\n');
    expect(lines.join('\n')).toContain('restored 1 file(s)');
  });
});
