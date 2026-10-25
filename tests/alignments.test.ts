/**
 * Unit tests for upstream alignments: README parsing, the info line, the upstream-only paths
 * and the PR body section.
 */
import { describe, expect, it } from 'vitest';
import { buildSyncPrBody } from '../src/services/sync';
import { formatAlignmentsLine, isUpstreamOnly, parseAlignment } from '../src/utils/alignments';

const readme = [
  '---',
  'syncBreaking: true',
  'clientCacheBump: false',
  'caughtBy: nothing',
  'generate: true',
  'grep: principalId, principals table',
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

describe('parseAlignment', () => {
  it('reads the frontmatter, title, summary and codemod', () => {
    expect(
      parseAlignment('20260923T0902-principal-to-actor', readme, ['README.md', 'rename.test.ts', 'rename.ts']),
    ).toEqual({
      id: '20260923T0902-principal-to-actor',
      title: 'Principal becomes actor',
      summary: 'The stored identity and the request-time value share one name.',
      syncBreaking: true,
      clientCacheBump: false,
      caughtBy: 'nothing',
      generate: true,
      grep: ['principalId', 'principals table'],
      roots: ['backend/src', 'frontend/src'],
      codemod: 'rename.ts',
    });
  });

  it('falls back to the id and empty values for a README without the shape', () => {
    expect(parseAlignment('20260101T0000-x', 'Just text.', ['README.md'])).toEqual({
      id: '20260101T0000-x',
      title: '20260101T0000-x',
      summary: '',
      syncBreaking: false,
      clientCacheBump: false,
      caughtBy: null,
      generate: false,
      grep: [],
      roots: [],
      codemod: null,
    });
    const unknownCatch = readme.replace('caughtBy: nothing', 'caughtBy: review');
    expect(parseAlignment('20260101T0000-x', unknownCatch, ['README.md']).caughtBy).toBeNull();
  });
});

describe('formatAlignmentsLine', () => {
  it('counts handled alignments and names the command while any are open', () => {
    expect(formatAlignmentsLine(97, 3, 3)).toBe(
      'alignments: 94 of 97 handled · 3 arrived with this sync · 3 open: pnpm cella align',
    );
    expect(formatAlignmentsLine(97, 0)).toBe('alignments: all 97 handled');
  });

  it('counts arrivals in a dry run as neither handled nor open', () => {
    expect(formatAlignmentsLine(97, 3, 2, { dryRun: true })).toBe(
      'alignments: 92 of 97 handled · 2 arrive with this sync · 3 open: pnpm cella align',
    );
    expect(formatAlignmentsLine(1, 0, 1, { dryRun: true })).toBe(
      'alignments: 0 of 1 handled · 1 arrives with this sync',
    );
  });
});

describe('isUpstreamOnly', () => {
  it('matches the alignments folder and the old notes folder, and nothing beside them', () => {
    expect(isUpstreamOnly('cella/alignments')).toBe(true);
    expect(isUpstreamOnly('cella/alignments/20260101T0000-x/README.md')).toBe(true);
    expect(isUpstreamOnly('cella/migrations/20260101T0000-x/README.md')).toBe(true);
    expect(isUpstreamOnly('cella/cella.alignments.json')).toBe(false);
    expect(isUpstreamOnly('cella/alignments-old/x.md')).toBe(false);
  });
});

describe('buildSyncPrBody alignments section', () => {
  const base = { repoSlug: 'cellajs/cella', toSha: 'b'.repeat(40), commits: [], totalCount: 0 };

  it('lists open alignments with their permalinks', () => {
    const body = buildSyncPrBody({
      ...base,
      alignments: {
        total: 97,
        open: [{ id: '20261002T0614-config-switch', title: 'Config switch', url: 'https://example.test/n' }],
      },
    });
    expect(body).toContain('**Alignments**: 96 of 97 handled, open (`pnpm cella align`):');
    expect(body).toContain('- [Config switch](https://example.test/n) (`20261002T0614-config-switch`)');
  });

  it('says so when every alignment is handled, and stays silent without alignments', () => {
    expect(buildSyncPrBody({ ...base, alignments: { total: 97, open: [] } })).toContain(
      '**Alignments**: all 97 handled.',
    );
    expect(buildSyncPrBody({ ...base, alignments: { total: 0, open: [] } })).not.toContain('Alignments');
  });
});
