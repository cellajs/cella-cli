/**
 * Tests for upstream-only changes to ignored paths.
 *
 * Ignored paths never upgrade. When both sides changed a file, `upstreamChanged` puts it in the
 * protected-but-behind section; when only upstream changed, added or deleted it, `classifyFiles`
 * flags it `upstreamOnly`, `groupIgnoredUpstreamChanges` groups it by its `ignored` entry, and
 * `printIgnoredUpstreamChanges` prints one line per entry.
 */
import { describe, expect, it } from 'vitest';
import { classifyFiles } from '../../src/upstream/classify';
import type { MergeResult } from '../../src/upstream/model';
import { groupIgnoredUpstreamChanges, isUnderAnyFolder } from '../../src/upstream/protection';
import { findProtectedBehindUpstream, printIgnoredUpstreamChanges } from '../../src/upstream/report';
import { isGeneratedFile } from '../../src/utils/repo-files';
import { captureInfo, trees } from '../helpers/test-env';

const ignored = [
  'own',
  'own/nested',
  'untouched',
  'sdk/gen',
  'frontend/src/routes/routeTree.gen.ts',
  'backend/drizzle',
];

/**
 * The merge-base, with `own` and `own/nested` ignored:
 * - own/changed.ts:      upstream changed, app untouched → upstreamOnly
 * - own/new.ts:          upstream added                   → upstreamOnly, new
 * - own/gone.ts:         upstream deleted, app untouched → upstreamOnly, deleted
 * - own/both.ts:         both changed                     → upstreamChanged (existing section)
 * - own/app-only.ts:    app changed only                → neither
 * - own/package.json:    upstream changed                 → managed, never flagged
 * - own/nested/deep.ts:  upstream changed                 → upstreamOnly, grouped under own/nested
 * - untouched/keep.ts:   nobody changed                   → no group
 * - plain.ts:            unprotected, upstream changed    → behind, never flagged
 * - sdk/gen/sdk.ts, frontend/src/routes/routeTree.gen.ts: upstream changed → generated, never flagged
 * - backend/drizzle/0001_init.sql: upstream changed, 0002_add_column.sql added → upstreamOnly
 */
const base = {
  'own/changed.ts': 'a',
  'own/gone.ts': 'a',
  'own/both.ts': 'a',
  'own/app-only.ts': 'a',
  'own/package.json': '{}',
  'own/nested/deep.ts': 'a',
  'untouched/keep.ts': 'a',
  'plain.ts': 'a',
  'sdk/gen/sdk.ts': 'sdk 1',
  'frontend/src/routes/routeTree.gen.ts': 'routes 1',
  'backend/drizzle/0001_init.sql': 'init 1',
};
const { 'own/gone.ts': _gone, ...upstreamKept } = base;
const upstream = {
  ...upstreamKept,
  'own/changed.ts': 'a newKey',
  'own/new.ts': 'added',
  'own/both.ts': 'a upstream',
  'own/package.json': '{ "version": "2" }',
  'own/nested/deep.ts': 'a upstream',
  'plain.ts': 'a upstream',
  'sdk/gen/sdk.ts': 'sdk 2',
  'frontend/src/routes/routeTree.gen.ts': 'routes 2',
  'backend/drizzle/0001_init.sql': 'init 2',
  'backend/drizzle/0002_add_column.sql': 'add column',
};
const app = { ...base, 'own/both.ts': 'a fork', 'own/app-only.ts': 'a fork' };

describe('ignored paths only upstream changed', () => {
  const files = classifyFiles(trees(base, app, upstream), {
    isIgnored: (p) => isUnderAnyFolder(p, ignored),
    isPinned: () => false,
  });
  const byPath = new Map(files.map((f) => [f.path, f]));

  it('flags changed, added and deleted files the app left alone', () => {
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
    expect(findProtectedBehindUpstream({ files }).map((f) => f.path)).toEqual(['own/both.ts']);
  });

  it('never flags app-only changes, managed files or unprotected files', () => {
    expect(byPath.get('own/app-only.ts')?.upstreamOnly).toBeUndefined();
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
    expect(groupIgnoredUpstreamChanges(files, ignored)).toEqual([
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
  const capture = (result: Partial<MergeResult>) =>
    captureInfo(() => printIgnoredUpstreamChanges(result as MergeResult));

  it('prints one line per ignored entry, without git diff lines', () => {
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
    expect(out).toContain('frontend/src/modules/my app · 1 file, 1 deleted');
    expect(out).not.toContain('git diff');
    // compact: the file paths themselves are not listed
    expect(out).not.toContain('shared/config/a.ts');
  });

  it('stays silent when nothing changed upstream under ignored paths', () => {
    expect(capture({ ignoredUpstreamChanges: [] })).toBe('');
    expect(capture({})).toBe('');
  });
});
