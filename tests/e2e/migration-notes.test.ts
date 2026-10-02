/**
 * E2E tests for upstream migration notes: the sync keeps `cella/migrations/` out of the fork,
 * records the notes that arrive as pending, and `cella migrate --mark` clears them.
 */
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAnalyze } from '../../src/services/analyze';
import { runMigrate } from '../../src/services/migrate';
import { runSync } from '../../src/services/sync';
import {
  buildRuntimeConfig,
  createTestEnv,
  fetchUpstream,
  fileExists,
  makeCommit,
  readRepoFile,
  resetFork,
  type TestEnv,
} from './helpers/test-env';

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
