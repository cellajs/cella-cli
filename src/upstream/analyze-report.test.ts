/**
 * Tests for the analyze file sections: the order they print in, the rows with their count and age
 * columns, the groups that collapse (behind by folder, pinned files missing few lines, protected
 * files under one override entry), `--all`, and where each row links.
 *
 * The fixture follows a real raak run in miniature. Its output is compared line by line: the
 * golden test the later refactors run against.
 */
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { captureInfo, analyzedFile as file } from '../../tests/helpers/test-env';
import { type AnalyzeReportOptions, printAnalysisFileGroups } from './analyze-report';
import type { AnalyzedFile, MergeResult } from './model';
import { groupIgnoredUpstreamChanges } from './protection';

const nowMs = 1_800_000_000_000;
const now = nowMs / 1000;
const hour = 3600;
const day = 86400;

const upstream = 'https://github.com/cellajs/cella';
const app = 'https://github.com/cellajs/raak';
const sha = 'b374861b9a0c';

const ignored = ['backend/drizzle', 'locales/en', 'frontend/src/modules/marketing', 'sdk/gen'];
const pinned = ['frontend/src/styling/app.css'];

/** A behind file upstream changed three hours ago; `new` or `deleted` when upstream added or removed it. */
function behind(path: string, kind?: 'new' | 'deleted'): AnalyzedFile {
  return file({
    path,
    status: 'behind',
    existsInApp: kind !== 'new',
    existsInUpstream: kind !== 'deleted',
    changedTs: now - 3 * hour,
    changedCommit: 'u1',
  });
}

function pinnedAhead(path: string, absent: number, ageSeconds: number): AnalyzedFile {
  return file({
    path,
    status: 'ahead',
    isPinned: true,
    upstreamLinesAbsent: absent,
    changedTs: now - ageSeconds,
    changedCommit: 'f1',
  });
}

function ignoredChanged(path: string, lines: number): AnalyzedFile {
  return file({
    path,
    status: 'ignored',
    isIgnored: true,
    upstreamChanged: true,
    upstreamChangedLines: lines,
    upstreamChangedTs: now - 3 * hour,
    upstreamCommit: 'u2',
  });
}

function fixture(): MergeResult {
  const files: AnalyzedFile[] = [
    behind('shared/scripts/check-alignments.ts', 'new'),
    behind('shared/scripts/check-migration-notes.ts', 'deleted'),
    behind('shared/scripts/check-style.ts'),
    behind('shared/scripts/prose-rules.ts'),
    behind('shared/scripts/README.md'),
    behind('cella/AGENTS.md'),
    behind('cella/CHANGELOG.md'),
    behind('cella/skills/align/SKILL.md', 'new'),
    behind('cella/skills/migrate/SKILL.md', 'deleted'),
    behind('backend/src/utils/get-ip.ts'),
    behind('backend/src/modules/push/push-sender.ts'),
    behind('backend/scripts/migrations/99-verify.migration.ts'),
    behind('infra/tasks/ensure-state-bucket.ts'),
    behind('infra/tasks/print-frontend-build-env.ts'),
    behind('frontend/src/lib/sw.ts'),
    behind('.gitattributes'),
    behind('package.json'),
    file({ path: 'knip.jsonc', status: 'diverged', upstreamChangedTs: now - 30, upstreamCommit: 'u3' }),
    file({ path: 'pnpm-workspace.yaml', status: 'diverged', upstreamChangedTs: now - 3 * hour, upstreamCommit: 'u4' }),
    pinnedAhead('cella/skills/screenshots/shots-config.mjs', 83, 15 * hour),
    pinnedAhead('frontend/src/alert-config.tsx', 36, 90 * day),
    pinnedAhead('frontend/src/styling/gradients.css', 16, 10 * day),
    pinnedAhead('a11y/scope-config.ts', 13, 2 * day),
    pinnedAhead('backend/src/bundle-config.ts', 1, 2 * day),
    pinnedAhead('backend/src/db/channel-tables.ts', 2, 56 * day),
    pinnedAhead('backend/src/modules.ts', 1, 13 * hour),
    pinnedAhead('frontend/src/routes-config.tsx', 1, 6 * day),
    pinnedAhead('frontend/src/entity-sync-queries.ts', 0, 21 * day),
    file({
      path: 'backend/src/utils/data-encryption.ts',
      status: 'drifted',
      changedTs: now - 2 * day,
      changedCommit: 'f2',
    }),
    file({
      path: 'frontend/src/modules/organization/organization-module.tsx',
      status: 'drifted',
      changedTs: now - 2 * day,
      changedCommit: 'f3',
    }),
    ignoredChanged('locales/en/about.json', 79),
    ignoredChanged('frontend/src/modules/marketing/marketing-config.tsx', 32),
    ignoredChanged('sdk/gen/types.gen.ts', 2),
    file({
      path: 'frontend/src/styling/app.css',
      status: 'pinned',
      isPinned: true,
      upstreamChanged: true,
      upstreamChangedLines: 4,
      upstreamChangedTs: now - 4 * 60,
      upstreamCommit: 'u5',
    }),
    ...['0718', '0721', '0723', '0729', '0730', '0814'].map((day) =>
      ignoredChanged(`backend/drizzle/2026${day}120000_m/snapshot.json`, 5500 + Number(day)),
    ),
    file({
      path: 'backend/drizzle/20261025063333_side_effects/migration.sql',
      status: 'ignored',
      isIgnored: true,
      existsInApp: false,
      upstreamOnly: true,
      upstreamChangedLines: 909,
      upstreamChangedTs: now - 3 * hour,
      upstreamCommit: 'u6',
    }),
  ];
  return {
    files,
    summary: {
      managed: 0,
      identical: 0,
      ahead: 0,
      local: 0,
      drifted: 0,
      behind: 0,
      diverged: 0,
      pinned: 0,
      ignored: 0,
      deleted: 0,
      renamed: 0,
    },
    conflicts: [],
    ignoredUpstreamChanges: groupIgnoredUpstreamChanges(files, ignored),
  };
}

const options: AnalyzeReportOptions = {
  links: { upstreamGitHubUrl: upstream, upstreamSha: sha, appGitHubUrl: app },
  ignored,
  pinned,
  columns: 80,
  nowMs,
};

/** The printed lines without colors or link targets. */
function report(result: MergeResult, extra: Partial<AnalyzeReportOptions> = {}): string[] {
  return stripVTControlCharacters(captureInfo(() => printAnalysisFileGroups(result, { ...options, ...extra }))).split(
    '\n',
  );
}

/** The raw output, link targets included. */
function raw(result: MergeResult, extra: Partial<AnalyzeReportOptions> = {}): string {
  return captureInfo(() => printAnalysisFileGroups(result, { ...options, ...extra }));
}

const div = '─'.repeat(60);

describe('printAnalysisFileGroups', () => {
  it('prints the sections from behind to protected but behind, large groups collapsed, columns aligned', () => {
    expect(report(fixture())).toEqual([
      '',
      '↓ behind on upstream · 16 files',
      div,
      '',
      '  shared/scripts/         5  +check-alignments.ts  −check-migration-notes.ts …',
      '  cella/                  4  +skills/align/SKILL.md  −skills/migrate/SKILL.md …',
      '  backend/                3  99-verify.migration.ts  get-ip.ts  push-sender.ts',
      '  infra/tasks/            2  ensure-state-bucket.ts …',
      '  .gitattributes          1',
      '  frontend/src/lib/sw.ts  1',
      '',
      '  every path: pnpm cella analyze --all',
      '',
      '⇅ diverged · 2 files',
      div,
      '',
      '  knip.jsonc           now',
      '  pnpm-workspace.yaml   3h',
      '',
      '↑ protected in app · 9 files',
      div,
      '',
      '                          upstream lines absent',
      '  cella/skills/screenshots/shots-config.mjs  83  15h',
      '  frontend/src/alert-config.tsx              36  3mo',
      '  frontend/src/styling/gradients.css         16  10d',
      '  a11y/scope-config.ts                       13   2d',
      '  + 5 more: 4 with 1–2 lines absent, 1 with none',
      '',
      '  what a merge would bring in: pnpm cella analyze --unpinned',
      '',
      '⚠ drifted from upstream · 2 files',
      div,
      '',
      '  backend/src/utils/data-encryption.ts                       2d',
      '  frontend/src/modules/organization/organization-module.tsx  2d',
      '',
      '⚠ protected but behind upstream · 10 files',
      div,
      '',
      '                                              lines changed upstream',
      '  ⨂ backend/drizzle/20261025063333_side_effects/migration.sql   +909  new  3h',
      '  ⨂ locales/en/about.json                                         79       3h',
      '  ⨂ frontend/src/modules/marketing/marketing-config.tsx           32       3h',
      '  ⨀ frontend/src/styling/app.css                                   4       4m',
      '  ⨂ backend/drizzle/ · 6 × snapshot.json                       37.4k       3h',
      '',
      '  the app side wins: adopt what you need from the review page',
    ]);
  });

  it('keeps every line within the terminal width it was given', () => {
    for (const line of report(fixture())) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('lists every path with --all: behind file by file, every pinned file, protected files uncollapsed', () => {
    const out = report(fixture(), { all: true });

    expect(out).toContain('  cella/skills/migrate/SKILL.md                      deleted  3h');
    expect(out).toContain('  frontend/src/entity-sync-queries.ts             3w');
    expect(out).toContain('  ⨂ backend/drizzle/20260718120000_m/snapshot.json             6218       3h');
    expect(out.join('\n')).not.toContain('every path');
    expect(out.join('\n')).not.toContain('× snapshot.json');
  });

  it('lists a short behind list file by file without the --all hint', () => {
    const result = fixture();
    result.files = result.files.filter((f) => f.status !== 'behind' || f.path.startsWith('cella/'));

    const out = report(result);

    expect(out).toContain('↓ behind on upstream · 4 files');
    expect(out).toContain('  cella/skills/align/SKILL.md    new      3h');
    expect(out.join('\n')).not.toContain('every path');
  });

  it('leaves managed and generated files out', () => {
    const out = report(fixture(), { all: true }).join('\n');

    expect(out).not.toContain('package.json');
    expect(out).not.toContain('sdk/gen');
  });

  it('prints nothing when no file needs a section', () => {
    expect(
      captureInfo(() => printAnalysisFileGroups({ ...fixture(), files: [], ignoredUpstreamChanges: [] }, options)),
    ).toBe('');
  });
});

describe('analyze row links', () => {
  it("links app-side rows to the app's commits, upstream-side rows to upstream's", () => {
    const out = raw(fixture(), { all: true });

    expect(out).toContain(`${app}/commit/f2`);
    expect(out).toContain(`${app}/commit/f1`);
    expect(out).toContain(`${upstream}/commit/u1`);
    expect(out).toContain(`${upstream}/commit/u3`);
    expect(out).not.toContain(`${upstream}/commit/f`);
  });

  it('leaves app commits unlinked without a GitHub origin', () => {
    const out = raw(fixture(), { all: true, links: { ...options.links, appGitHubUrl: undefined } });

    expect(out).not.toContain('/commit/f');
    expect(out).toContain(`${upstream}/commit/u1`);
  });

  it('links files at the analyzed upstream commit in file mode, and not at all when upstream deleted them', () => {
    const out = raw(fixture(), { all: true, links: { ...options.links, fileLinkMode: 'file' } });

    expect(out).toContain(`${upstream}/blob/${sha}/shared/scripts/check-style.ts`);
    expect(out).not.toContain('/blob/main/');
    expect(out).not.toContain('check-migration-notes.ts\x07');
  });

  it("links a collapsed entry to upstream's folder at the analyzed commit", () => {
    expect(raw(fixture())).toContain(`${upstream}/tree/${sha}/backend/drizzle`);
  });
});
