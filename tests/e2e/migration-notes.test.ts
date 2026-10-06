/**
 * E2E tests for upstream migration notes: the sync keeps `cella/migrations/` out of the fork,
 * records the notes that arrive as pending, and `cella migrate --mark` clears them.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalyze } from '../../src/services/analyze';
import { runMigrate } from '../../src/services/migrate';
import { runSync, runSyncCommand } from '../../src/services/sync';
import {
  buildRuntimeConfig,
  createTestEnv,
  deleteFileAndCommit,
  fetchUpstream,
  fileExists,
  makeCommit,
  readRepoFile,
  resetFork,
  type TestEnv,
} from '../helpers/test-env';

// The full `runSyncCommand` flow runs `pnpm install` + `pnpm check` before it commits, and asks for `gh`
vi.mock('node:child_process', async (importOriginal) => {
  const { mockPnpmAndGh } = await import('../helpers/mock-pnpm-gh');
  return mockPnpmAndGh(await importOriginal<typeof import('node:child_process')>());
});

const note = (title: string) =>
  `---\nsyncBreaking: true\nclientCacheBump: false\n---\n\n# ${title}\n\nWhat the app changes.\n`;
const OLD = '20260101T0000-old-note';
const NEW = '20260102T0000-new-note';

function pending(forkPath: string): unknown {
  const raw = readRepoFile(forkPath, 'cella/cella.migrations.json');
  return raw === null ? null : JSON.parse(raw);
}

describe('migration notes e2e', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    resetFork(env.forkPath);
    env.cleanup();
  });

  it('records arriving notes as pending and never brings the folder in', async () => {
    makeCommit(env.upstreamPath, {
      files: { [`cella/migrations/${NEW}/README.md`]: note('New note'), 'feature.ts': 'export const f = 1;\n' },
      message: 'feat: new note',
    });

    fetchUpstream(env.forkPath);
    const result = await runSync(buildRuntimeConfig(env, { service: 'sync' }));

    expect(fileExists(env.forkPath, 'feature.ts')).toBe(true);
    expect(fileExists(env.forkPath, 'cella/migrations')).toBe(false);
    expect(pending(env.forkPath)).toEqual({ pending: [NEW] });
    expect(result.migrationNotes).toEqual({ total: 1, arrived: [NEW], open: 1 });
  });

  it('converts an old applied-set and removes the synced copy of the folder', async () => {
    // An older sync brought the folder in, and the app recorded the first note as applied.
    makeCommit(env.upstreamPath, {
      files: { [`cella/migrations/${OLD}/README.md`]: note('Old note') },
      message: 'feat: old note',
    });
    fetchUpstream(env.forkPath);
    execSync('git merge --ff-only cella-upstream/main', { cwd: env.forkPath, stdio: 'pipe' });
    makeCommit(env.forkPath, {
      files: { 'cella/cella.migrations.json': `${JSON.stringify({ applied: [OLD] })}\n` },
      message: 'chore: applied',
    });

    makeCommit(env.upstreamPath, {
      files: { [`cella/migrations/${NEW}/README.md`]: note('New note') },
      message: 'feat: new note',
    });
    fetchUpstream(env.forkPath);
    const result = await runSync(buildRuntimeConfig(env, { service: 'sync' }));

    expect(fileExists(env.forkPath, 'cella/migrations')).toBe(false);
    expect(execSync('git ls-files cella/migrations', { cwd: env.forkPath, encoding: 'utf8' }).trim()).toBe('');
    expect(pending(env.forkPath)).toEqual({ pending: [NEW] });
    expect(result.migrationNotes).toEqual({ total: 2, arrived: [NEW], open: 1 });
  });

  it('removes the copy and converts the record when the sync stops at conflicts, and the rerun keeps it gone', async () => {
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: env.forkPath, encoding: 'utf8' }).trim();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    // Legacy state: an older sync brought the whole folder in, and the app recorded the applied set
    makeCommit(env.upstreamPath, {
      files: {
        'cella/migrations/README.md': '# Migrations\n',
        [`cella/migrations/${OLD}/README.md`]: '# Old note\n\nWhat the app changes.\n',
        [`cella/migrations/${OLD}/codemod.ts`]: 'export const codemod = 1;\n',
      },
      message: 'feat: old note',
    });
    fetchUpstream(env.forkPath);
    git('merge --ff-only cella-upstream/main');
    // The test fork is a clone of upstream: without this its trunk tracks upstream and fast-forwards to it
    git('branch --unset-upstream main');
    makeCommit(env.forkPath, {
      files: {
        'cella/cella.migrations.json': `${JSON.stringify({ applied: [OLD] })}\n`,
        'README.md': '# Fork readme\n',
      },
      message: 'chore: applied, own readme',
    });

    // Upstream, in the sync range: changes existing note files, deletes one, adds a note, and conflicts elsewhere
    makeCommit(env.upstreamPath, {
      files: {
        'cella/migrations/README.md': '# Migrations\n\nNotes stay upstream.\n',
        [`cella/migrations/${OLD}/README.md`]: note('Old note'),
        [`cella/migrations/${NEW}/README.md`]: note('New note'),
        [`cella/migrations/${NEW}/codemod.ts`]: 'export const codemod = 2;\n',
        'README.md': '# Upstream readme\n',
      },
      message: 'feat: new note, frontmatter on the old one',
    });
    deleteFileAndCommit(env.upstreamPath, `cella/migrations/${OLD}/codemod.ts`, 'chore: drop old codemod');

    try {
      // First run: stops at the conflict, with the folder already gone and the record converted
      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync' }));

      const branch = git('rev-parse --abbrev-ref HEAD');
      expect(branch).toMatch(/^cella\/sync\//);
      expect(git('diff --name-only --diff-filter=U')).toBe('README.md');
      expect(fileExists(env.forkPath, 'cella/migrations')).toBe(false);
      expect(git('ls-files cella/migrations')).toBe('');
      expect(pending(env.forkPath)).toEqual({ pending: [NEW] });

      // Finishing rerun: commits the resolved merge, and the folder stays gone
      fs.writeFileSync(path.join(env.forkPath, 'README.md'), '# Fork readme\n');
      git('add README.md');
      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync' }));

      expect(git('rev-parse --abbrev-ref HEAD')).toBe(branch);
      expect(git('log -1 --format=%s')).toMatch(/^chore: sync upstream cella/);
      expect(git('status --porcelain')).toBe('');
      expect(git('ls-tree -r --name-only HEAD -- cella/migrations')).toBe('');
      expect(fileExists(env.forkPath, 'cella/migrations')).toBe(false);
      expect(JSON.parse(git('show HEAD:cella/cella.migrations.json'))).toEqual({ pending: [NEW] });
    } finally {
      info.mockRestore();
    }
  });

  it('reports arriving notes in analyze without writing anything', async () => {
    makeCommit(env.upstreamPath, {
      files: { [`cella/migrations/${NEW}/README.md`]: note('New note') },
      message: 'feat: new note',
    });
    fetchUpstream(env.forkPath);

    const result = await runAnalyze(buildRuntimeConfig(env, { service: 'analyze' }));

    expect(result.migrationNotes).toEqual({ total: 1, arrived: [NEW], open: 1 });
    expect(pending(env.forkPath)).toBeNull();
  });

  it('marks a note as handled and deletes the file once nothing is pending', async () => {
    makeCommit(env.upstreamPath, {
      files: { [`cella/migrations/${NEW}/README.md`]: note('New note') },
      message: 'feat: new note',
    });
    fetchUpstream(env.forkPath);
    await runSync(buildRuntimeConfig(env, { service: 'sync' }));

    await runMigrate({ ...buildRuntimeConfig(env, { service: 'migrate' }), mark: [NEW] });

    expect(pending(env.forkPath)).toBeNull();
  });
});
