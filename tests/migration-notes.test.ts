/**
 * Unit tests for upstream migration notes: README parsing, the info line, the upstream-only path
 * and the PR body section.
 */
import { describe, expect, it } from 'vitest';
import { buildSyncPrBody } from '../src/services/sync';
import { formatNotesLine, isUpstreamOnly, parseNote } from '../src/utils/migration-notes';

const readme = [
  '---',
  'syncBreaking: true',
  'clientCacheBump: false',
  'roots: backend/src, frontend/src',
  '---',
  '',
  '<!-- authoring hint -->',
  '',
  '# Principal becomes actor',
  '',
  'The stored identity and the request-time value',
  'share one name.',
  '',
  '## What & why',
].join('\n');

describe('parseNote', () => {
  it('reads the frontmatter, title, summary and codemod', () => {
    expect(parseNote('20260923T0902-principal-to-actor', readme, ['README.md', 'rename.test.ts', 'rename.ts'])).toEqual(
      {
        id: '20260923T0902-principal-to-actor',
        title: 'Principal becomes actor',
        summary: 'The stored identity and the request-time value share one name.',
        syncBreaking: true,
        clientCacheBump: false,
        roots: ['backend/src', 'frontend/src'],
        codemod: 'rename.ts',
      },
    );
  });

  it('falls back to the id and empty values for a README without the shape', () => {
    expect(parseNote('20260101T0000-x', 'Just text.', ['README.md'])).toEqual({
      id: '20260101T0000-x',
      title: '20260101T0000-x',
      summary: '',
      syncBreaking: false,
      clientCacheBump: false,
      roots: [],
      codemod: null,
    });
  });
});

describe('formatNotesLine', () => {
  it('counts handled notes and names the command while any are open', () => {
    expect(formatNotesLine(97, 3, 3)).toBe(
      'migration notes: 94 of 97 handled · 3 arrived with this sync · 3 open: pnpm cella migrate',
    );
    expect(formatNotesLine(97, 3, 2, { dryRun: true })).toBe(
      'migration notes: 94 of 97 handled · 2 arrive with this sync · 3 open: pnpm cella migrate',
    );
    expect(formatNotesLine(97, 0)).toBe('migration notes: all 97 handled');
  });
});

describe('isUpstreamOnly', () => {
  it('matches the notes folder and nothing beside it', () => {
    expect(isUpstreamOnly('cella/migrations')).toBe(true);
    expect(isUpstreamOnly('cella/migrations/20260101T0000-x/README.md')).toBe(true);
    expect(isUpstreamOnly('cella/cella.migrations.json')).toBe(false);
    expect(isUpstreamOnly('cella/migrations-old/x.md')).toBe(false);
  });
});

describe('buildSyncPrBody notes section', () => {
  const base = { repoSlug: 'cellajs/cella', toSha: 'b'.repeat(40), commits: [], totalCount: 0 };

  it('lists open notes with their permalinks', () => {
    const body = buildSyncPrBody({
      ...base,
      notes: {
        total: 97,
        open: [{ id: '20261002T0614-config-switch', title: 'Config switch', url: 'https://example.test/n' }],
      },
    });
    expect(body).toContain('**Migration notes**: 96 of 97 handled, open (`pnpm cella migrate`):');
    expect(body).toContain('- [Config switch](https://example.test/n) (`20261002T0614-config-switch`)');
  });

  it('says so when every note is handled, and stays silent without notes', () => {
    expect(buildSyncPrBody({ ...base, notes: { total: 97, open: [] } })).toContain(
      '**Migration notes**: all 97 handled.',
    );
    expect(buildSyncPrBody({ ...base, notes: { total: 0, open: [] } })).not.toContain('Migration notes');
  });
});
