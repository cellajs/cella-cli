/**
 * Unit tests for upstream alignments: README parsing, the grep hits, the info line, the
 * upstream-only paths and the PR body section.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatAlignmentsLine,
  grepAlignmentTerms,
  isUpstreamOnly,
  parseAlignment,
  pendingFile,
  writePending,
} from './alignments';
import { buildUpgradePrBody } from './pull-requests';

const readme = [
  '---',
  'breaking: true',
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
      breaking: true,
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
      breaking: false,
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

describe('grepAlignmentTerms', () => {
  // Under git's -w these terms matched only beside another non-word character, so `data.results` was missed
  it('finds a term with a non-word edge inside a longer word', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'alignment-grep-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(
        join(repo, 'a.ts'),
        [
          'const rows = data.results;',
          'if (user.onboarding_completed) {}',
          'const principalIds = [];',
          'principalId',
        ].join('\n'),
      );
      execFileSync('git', ['add', '.'], { cwd: repo });
      const hits = await grepAlignmentTerms(repo, ['.results', 'onboarding_', 'principalId'], () => true);
      expect(hits).toEqual([
        { file: 'a.ts', line: 1 },
        { file: 'a.ts', line: 2 },
        { file: 'a.ts', line: 4 },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('writePending', () => {
  it('never writes through a symlink upstream planted at the pending file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alignment-pending-'));
    try {
      const repo = join(root, 'app');
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'secret\n');
      mkdirSync(join(repo, 'cella'), { recursive: true });
      symlinkSync(outside, join(repo, pendingFile));
      await writePending(repo, ['20260101T0000-example']);
      expect(readFileSync(outside, 'utf8')).toBe('secret\n');
      expect(lstatSync(join(repo, pendingFile)).isFile()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formatAlignmentsLine', () => {
  it('counts handled alignments and names the command while any are open', () => {
    expect(formatAlignmentsLine(97, 3)).toBe('alignments: 94 of 97 handled · 3 open: pnpm cella align');
    expect(formatAlignmentsLine(97, 0)).toBe('alignments: all 97 handled');
  });
});

describe('isUpstreamOnly', () => {
  it('matches the alignments folder, and nothing beside it', () => {
    expect(isUpstreamOnly('cella/alignments')).toBe(true);
    expect(isUpstreamOnly('cella/alignments/20260101T0000-x/README.md')).toBe(true);
    expect(isUpstreamOnly('cella/cella.alignments.json')).toBe(false);
    expect(isUpstreamOnly('cella/alignments-old/x.md')).toBe(false);
  });
});

describe('buildUpgradePrBody alignments section', () => {
  const base = { repoSlug: 'cellajs/cella', toSha: 'b'.repeat(40), commits: [], totalCount: 0 };

  it('lists open alignments with their permalinks', () => {
    const body = buildUpgradePrBody({
      ...base,
      alignments: {
        total: 97,
        open: [{ id: '20261002T0614-config-switch', title: 'Config switch', url: 'https://example.test/n' }],
      },
    });
    expect(body).toContain('**Alignments**: 96 of 97 handled, open (`pnpm cella align`):');
    expect(body).toContain('- [`Config switch`](https://example.test/n) (`20261002T0614-config-switch`)');
  });

  it('says so when every alignment is handled, and stays silent without alignments', () => {
    expect(buildUpgradePrBody({ ...base, alignments: { total: 97, open: [] } })).toContain(
      '**Alignments**: all 97 handled.',
    );
    expect(buildUpgradePrBody({ ...base, alignments: { total: 0, open: [] } })).not.toContain('Alignments');
  });
});
