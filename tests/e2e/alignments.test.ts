/**
 * E2E tests for upstream alignments: the sync keeps `cella/alignments/` (and the old
 * `cella/migrations/`) out of the fork, records the alignments that arrive as pending, and
 * `cella align --mark` clears them.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAlign } from '../../src/services/align';
import { runAnalyze } from '../../src/services/analyze';
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

const readme = (title: string) =>
  `---\nsyncBreaking: true\nclientCacheBump: false\ncaughtBy: compiler\n---\n\n# ${title}\n\nWhat the app changes.\n`;
const OLD = '20260101T0000-old-alignment';
const NEW = '20260102T0000-new-alignment';

function pending(forkPath: string): unknown {
  const raw = readRepoFile(forkPath, 'cella/cella.alignments.json');
  return raw === null ? null : JSON.parse(raw);
}

describe('alignments e2e', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    resetFork(env.forkPath);
    env.cleanup();
  });

  it('records arriving alignments as pending and never brings the folder in', async () => {
    makeCommit(env.upstreamPath, {
      files: { [`cella/alignments/${NEW}/README.md`]: readme('New alignment'), 'feature.ts': 'export const f = 1;\n' },
      message: 'feat: new alignment',
    });

    fetchUpstream(env.forkPath);
    const result = await runSync(buildRuntimeConfig(env, { service: 'sync' }));

    expect(fileExists(env.forkPath, 'feature.ts')).toBe(true);
    expect(fileExists(env.forkPath, 'cella/alignments')).toBe(false);
    expect(pending(env.forkPath)).toEqual({ pending: [NEW] });
    expect(result.alignments).toEqual({ total: 1, arrived: [NEW], open: [NEW] });
  });

  it('gives an app synced before the alignments only the ones upstream holds after deleting its notes', async () => {
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: env.forkPath, encoding: 'utf8' }).trim();

    // An older sync point: upstream kept migration notes, and an older sync copied them into the fork
    makeCommit(env.upstreamPath, {
      files: { 'cella/migrations/README.md': '# Migrations\n', [`cella/migrations/${OLD}/README.md`]: readme('Old') },
      message: 'feat: old migration note',
    });
    fetchUpstream(env.forkPath);
    git('merge -q --ff-only cella-upstream/main');

    // Upstream deletes every note and starts the alignments
    deleteFileAndCommit(env.upstreamPath, `cella/migrations/${OLD}/README.md`, 'chore: drop the old note');
    deleteFileAndCommit(env.upstreamPath, 'cella/migrations/README.md', 'chore: drop the notes readme');
    makeCommit(env.upstreamPath, {
      files: { [`cella/alignments/${NEW}/README.md`]: readme('First alignment') },
      message: 'refactor!: migration notes become alignments',
    });
    fetchUpstream(env.forkPath);

    const result = await runSync(buildRuntimeConfig(env, { service: 'sync' }));

    expect(result.alignments).toEqual({ total: 1, arrived: [NEW], open: [NEW] });
    expect(pending(env.forkPath)).toEqual({ pending: [NEW] });
    expect(fileExists(env.forkPath, 'cella/migrations')).toBe(false);
    expect(fileExists(env.forkPath, 'cella/alignments')).toBe(false);
  });

  it('removes the copy when the sync stops at conflicts, and the rerun keeps it gone', async () => {
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: env.forkPath, encoding: 'utf8' }).trim();
    const lines: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const printed = () => stripVTControlCharacters(lines.splice(0).join('\n'));

    // An older sync brought the whole folder in
    makeCommit(env.upstreamPath, {
      files: {
        'cella/alignments/README.md': '# Alignments\n',
        [`cella/alignments/${OLD}/README.md`]: '# Old alignment\n\nWhat the app changes.\n',
        [`cella/alignments/${OLD}/codemod.ts`]: 'export const codemod = 1;\n',
      },
      message: 'feat: old alignment',
    });
    fetchUpstream(env.forkPath);
    git('merge --ff-only cella-upstream/main');
    // The test fork is a clone of upstream: without this its trunk tracks upstream and fast-forwards to it
    git('branch --unset-upstream main');
    makeCommit(env.forkPath, {
      files: { 'README.md': '# Fork readme\n' },
      message: 'chore: own readme',
    });

    // Upstream, in the sync range: changes existing alignment files, deletes one, adds an alignment, and conflicts elsewhere
    makeCommit(env.upstreamPath, {
      files: {
        'cella/alignments/README.md': '# Alignments\n\nAlignments stay upstream.\n',
        [`cella/alignments/${OLD}/README.md`]: readme('Old alignment'),
        [`cella/alignments/${NEW}/README.md`]: readme('New alignment'),
        [`cella/alignments/${NEW}/codemod.ts`]: 'export const codemod = 2;\n',
        'README.md': '# Upstream readme\n',
      },
      message: 'feat: new alignment, frontmatter on the old one',
    });
    deleteFileAndCommit(env.upstreamPath, `cella/alignments/${OLD}/codemod.ts`, 'chore: drop old codemod');

    try {
      // First run: stops at the conflict, with the folder already gone
      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync' }));

      const branch = git('rev-parse --abbrev-ref HEAD');
      expect(branch).toMatch(/^cella\/sync\//);
      expect(git('diff --name-only --diff-filter=U')).toBe('README.md');
      expect(fileExists(env.forkPath, 'cella/alignments')).toBe(false);
      expect(git('ls-files cella/alignments')).toBe('');
      expect(pending(env.forkPath)).toEqual({ pending: [NEW] });
      // It ends on what to do: resolve the conflict, let a rerun commit, and the alignment that arrived
      const stopped = printed();
      expect(stopped).toMatch(
        /next steps\n─+\n\n {2}1 resolve {2}1 conflict in your editor, then stage them\n {13}README\.md\n/,
      );
      expect(stopped).toMatch(/ {2}2 finish {3}pnpm cella sync\n/);
      expect(stopped).toMatch(/ {2}\d align {4}1 alignment open · 1 arrived with this sync\n/);
      expect(stopped).toContain('○ New alignment · codemod · sync-breaking · caught by compiler');
      expect(stopped).toContain(`  id ${NEW}`);

      // Finishing rerun: commits the resolved merge, and the folder stays gone
      fs.writeFileSync(path.join(env.forkPath, 'README.md'), '# Fork readme\n');
      git('add README.md');
      await runSyncCommand(buildRuntimeConfig(env, { service: 'sync' }));

      expect(git('rev-parse --abbrev-ref HEAD')).toBe(branch);
      expect(git('log -1 --format=%s')).toMatch(/^chore: sync upstream cella/);
      // The commit stop: triage, the open alignment once, and the ship rerun
      const committed = printed();
      expect(committed).toMatch(/✓ committed {2}chore: sync upstream cella/);
      expect(committed).toMatch(/ {2}\d triage {3}pnpm cella analyze\n/);
      expect(committed).toMatch(/ {2}\d align {4}1 alignment open\n/);
      expect(committed).toMatch(/ {2}\d ship {5}pnpm cella sync\n/);
      expect(committed.match(/New alignment/g)).toHaveLength(1);
      expect(committed).not.toContain('alignments:');
      expect(git('status --porcelain')).toBe('');
      expect(git('ls-tree -r --name-only HEAD -- cella/alignments')).toBe('');
      expect(fileExists(env.forkPath, 'cella/alignments')).toBe(false);
      expect(JSON.parse(git('show HEAD:cella/cella.alignments.json'))).toEqual({ pending: [NEW] });
    } finally {
      info.mockRestore();
    }
  });

  it('reports arriving alignments in analyze without writing anything', async () => {
    makeCommit(env.upstreamPath, {
      files: { [`cella/alignments/${NEW}/README.md`]: readme('New alignment') },
      message: 'feat: new alignment',
    });
    fetchUpstream(env.forkPath);

    const lines: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const result = await runAnalyze(buildRuntimeConfig(env, { service: 'analyze' })).finally(() => info.mockRestore());

    expect(result.alignments).toEqual({ total: 1, arrived: [NEW], open: [] });
    expect(pending(env.forkPath)).toBeNull();
    // Arriving, not open: `pnpm cella align` lists it only once the sync lands
    const out = stripVTControlCharacters(lines.join('\n'));
    expect(out).toContain('○ New alignment · manual · sync-breaking · caught by compiler');
    expect(out).toContain('after the sync: pnpm cella align');
    // Only the alignment changed upstream: the sync still records it and moves the sync point
    expect(out).toMatch(
      / {2}1 sync {5}pnpm cella sync\n {13}commits on a fresh branch, a rerun opens the PR · no synced file changes\n/,
    );
    expect(out).toMatch(/ {2}2 align {4}1 alignment arrives with this sync\n/);
  });

  it('marks an alignment as handled and deletes the file once nothing is pending', async () => {
    makeCommit(env.upstreamPath, {
      files: { [`cella/alignments/${NEW}/README.md`]: readme('New alignment') },
      message: 'feat: new alignment',
    });
    fetchUpstream(env.forkPath);
    await runSync(buildRuntimeConfig(env, { service: 'sync' }));

    await runAlign({ ...buildRuntimeConfig(env, { service: 'align' }), mark: [NEW] });

    expect(pending(env.forkPath)).toBeNull();
  });
});
