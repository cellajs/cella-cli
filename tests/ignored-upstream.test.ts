/**
 * Tests for upstream-only changes to ignored paths.
 *
 * Ignored paths never sync. When both sides changed a file, `upstreamChanged` puts it in the
 * protected-but-behind section; when only upstream changed, added or deleted it, `analyzeRefs`
 * flags it `upstreamOnly`, `groupIgnoredUpstreamChanges` groups it by its `ignored` entry, and
 * `printIgnoredUpstreamChanges` prints one line plus a `git diff` hint per entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzedFile, MergeResult } from '../src/config/types';
import { analyzeRefs } from '../src/services/analyze-core';
import { findProtectedBehind, printIgnoredUpstreamChanges } from '../src/utils/display';
import { getMergeBase } from '../src/utils/git';
import { isGeneratedFile } from '../src/utils/managed-files';
import { groupIgnoredUpstreamChanges, isUnderAnyFolder } from '../src/utils/overrides';
import { createRepo, exec, write } from './helpers/test-env';

const IGNORED = [
  'own',
  'own/nested',
  'untouched',
  'sdk/gen',
  'frontend/src/routes/routeTree.gen.ts',
  'backend/drizzle',
];

/**
 * Repo with a `main` (fork) and `upstream` branch off one base commit, `own` and `own/nested` ignored:
 * - own/changed.ts:      upstream changed, fork untouched → upstreamOnly
 * - own/new.ts:          upstream added                   → upstreamOnly, new
 * - own/gone.ts:         upstream deleted, fork untouched → upstreamOnly, deleted
 * - own/both.ts:         both changed                     → upstreamChanged (existing section)
 * - own/fork-only.ts:    fork changed only                → neither
 * - own/package.json:    upstream changed                 → managed, never flagged
 * - own/nested/deep.ts:  upstream changed                 → upstreamOnly, grouped under own/nested
 * - untouched/keep.ts:   nobody changed                   → no group
 * - plain.ts:            unprotected, upstream changed    → behind, never flagged
 * - sdk/gen/sdk.ts, frontend/src/routes/routeTree.gen.ts: upstream changed → generated, never flagged
 * - backend/drizzle/0001_init.sql: upstream changed, 0002_add_column.sql added → upstreamOnly
 */
function createScenarioRepo(): string {
  const dir = createRepo('cella-ignored-upstream-');

  write(dir, {
    'own/changed.ts': 'a\n',
    'own/gone.ts': 'a\n',
    'own/both.ts': 'a\n',
    'own/fork-only.ts': 'a\n',
    'own/package.json': '{}\n',
    'own/nested/deep.ts': 'a\n',
    'untouched/keep.ts': 'a\n',
    'plain.ts': 'a\n',
    'sdk/gen/sdk.ts': 'export const sdk = 1;\n',
    'frontend/src/routes/routeTree.gen.ts': 'export const routeTree = [];\n',
    'backend/drizzle/0001_init.sql': 'CREATE TABLE users (id text);\n',
  });
  exec('git add -A && git commit -q -m base', dir);

  exec('git checkout -q -b upstream', dir);
  write(dir, {
    'own/changed.ts': 'a\nnewKey: true\n',
    'own/new.ts': 'export const added = true;\n',
  });
  fs.rmSync(path.join(dir, 'own/gone.ts'));
  write(dir, {
    'own/both.ts': 'a\nupstream\n',
    'own/package.json': '{ "version": "2" }\n',
    'own/nested/deep.ts': 'a\nupstream\n',
    'plain.ts': 'a\nupstream\n',
    'sdk/gen/sdk.ts': 'export const sdk = 2;\n',
    'frontend/src/routes/routeTree.gen.ts': "export const routeTree = ['/about'];\n",
    'backend/drizzle/0001_init.sql': 'CREATE TABLE users (id text PRIMARY KEY);\n',
    'backend/drizzle/0002_add_column.sql': 'ALTER TABLE users ADD COLUMN name text;\n',
  });
  exec('git add -A && git commit -q -m upstream', dir);

  exec('git checkout -q main', dir);
  write(dir, {
    'own/both.ts': 'a\nfork\n',
    'own/fork-only.ts': 'a\nfork\n',
  });
  exec('git add -A && git commit -q -m fork', dir);

  return dir;
}

describe('ignored paths only upstream changed', () => {
  let repoPath: string;
  let files: AnalyzedFile[];
  let byPath: Map<string, AnalyzedFile>;

  beforeEach(async () => {
    repoPath = createScenarioRepo();
    const mergeBase = await getMergeBase(repoPath, 'main', 'upstream');
    files = await analyzeRefs(repoPath, 'main', 'upstream', mergeBase, {
      isIgnored: (p) => isUnderAnyFolder(p, IGNORED),
      isPinned: () => false,
    });
    byPath = new Map(files.map((f) => [f.path, f]));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('flags changed, added and deleted files the fork left alone', () => {
    for (const p of ['own/changed.ts', 'own/new.ts', 'own/gone.ts', 'own/nested/deep.ts']) {
      expect(byPath.get(p)?.status, p).toBe('ignored');
      expect(byPath.get(p)?.upstreamOnly, p).toBe(true);
      expect(byPath.get(p)?.upstreamChanged, p).toBeUndefined();
    }
  });

  it('keeps a file both sides changed in the protected-but-behind section only', () => {
    const both = byPath.get('own/both.ts');
    expect(both?.upstreamChanged).toBe(true);
    expect(both?.upstreamOnly).toBeUndefined();
    expect(findProtectedBehind(files).map((f) => f.path)).toEqual(['own/both.ts']);
  });

  it('never flags fork-only changes, managed files or unprotected files', () => {
    expect(byPath.get('own/fork-only.ts')?.upstreamOnly).toBeUndefined();
    expect(byPath.get('own/package.json')?.upstreamOnly).toBeUndefined();
    expect(byPath.get('plain.ts')?.status).toBe('behind');
    expect(byPath.get('plain.ts')?.upstreamOnly).toBeUndefined();
  });

  it('leaves out generated output but keeps upstream migrations', () => {
    for (const p of ['sdk/gen/sdk.ts', 'frontend/src/routes/routeTree.gen.ts']) {
      expect(byPath.get(p)?.status, p).toBe('ignored');
      expect(byPath.get(p)?.upstreamOnly, p).toBeUndefined();
    }
    expect(byPath.get('backend/drizzle/0001_init.sql')?.upstreamOnly).toBe(true);
    expect(byPath.get('backend/drizzle/0002_add_column.sql')?.upstreamOnly).toBe(true);
  });

  it('groups flagged files under the most specific ignored entry, in config order', () => {
    expect(groupIgnoredUpstreamChanges(files, IGNORED)).toEqual([
      { entry: 'own', paths: ['own/changed.ts', 'own/gone.ts', 'own/new.ts'], added: 1, deleted: 1 },
      { entry: 'own/nested', paths: ['own/nested/deep.ts'], added: 0, deleted: 0 },
      {
        entry: 'backend/drizzle',
        paths: ['backend/drizzle/0001_init.sql', 'backend/drizzle/0002_add_column.sql'],
        added: 1,
        deleted: 0,
      },
    ]);
  });
});

describe('isGeneratedFile', () => {
  it('matches a gen path segment or a .gen. file name', () => {
    expect(isGeneratedFile('sdk/gen/sdk.ts')).toBe(true);
    expect(isGeneratedFile('sdk/gen/docs.gen/details.gen/tenants.gen.json')).toBe(true);
    expect(isGeneratedFile('frontend/src/routes/routeTree.gen.ts')).toBe(true);
    expect(isGeneratedFile('infra/compose.gen.yml')).toBe(true);
  });

  it('leaves other paths alone, migrations included', () => {
    expect(isGeneratedFile('backend/drizzle/0001_init.sql')).toBe(false);
    expect(isGeneratedFile('shared/config/default.ts')).toBe(false);
    expect(isGeneratedFile('frontend/src/generator.ts')).toBe(false);
    expect(isGeneratedFile('backend/src/gen-token.ts')).toBe(false);
  });
});

describe('printIgnoredUpstreamChanges', () => {
  function capture(result: Partial<MergeResult>): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      printIgnoredUpstreamChanges(result as MergeResult);
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('prints one line and one git diff hint per ignored entry', () => {
    const out = capture({
      upstreamDiffRange: '1a2b3c4..5d6e7f8',
      ignoredUpstreamChanges: [
        {
          entry: 'shared/config',
          paths: ['shared/config/a.ts', 'shared/config/b.ts', 'shared/config/c.ts'],
          added: 1,
          deleted: 0,
        },
        { entry: 'frontend/src/modules/my app', paths: ['frontend/src/modules/my app/x.ts'], added: 0, deleted: 1 },
      ],
    });
    expect(out).toContain('ignored paths changed upstream · 4 files under 2 entries');
    expect(out).toContain('shared/config · 3 files, 1 new');
    expect(out).toContain('git diff 1a2b3c4..5d6e7f8 -- shared/config');
    expect(out).toContain('frontend/src/modules/my app · 1 file, 1 deleted');
    expect(out).toContain(`git diff 1a2b3c4..5d6e7f8 -- 'frontend/src/modules/my app'`);
    // compact: the file paths themselves are not listed
    expect(out).not.toContain('shared/config/a.ts');
  });

  it('stays silent when nothing changed upstream under ignored paths', () => {
    expect(capture({ ignoredUpstreamChanges: [] })).toBe('');
    expect(capture({})).toBe('');
  });
});
