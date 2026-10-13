import { describe, expect, it } from 'vitest';
import {
  type Advisory,
  advisoriesFromAudit,
  isAuditOverride,
  liveExcludes,
  overrideModule,
  type PlanInput,
  parseVersionedExclude,
  planSecurity,
  standingOverrides,
} from '../src/utils/security-plan';
import { isBreakingJump, satisfiesComparators } from '../src/utils/versions';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-13T12:00:00Z');
const OLD = '2024-01-01T00:00:00Z';

/** Publish times for a list of versions, all long ago unless given a time. */
const published = (versions: string[], times: Record<string, string> = {}) =>
  Object.fromEntries(versions.map((version) => [version, times[version] ?? OLD]));

const advisory = (
  partial: Partial<Advisory> & Pick<Advisory, 'ghsa' | 'module' | 'range' | 'installed'>,
): Advisory => ({
  severity: 'high',
  via: ['parent'],
  direct: false,
  ...partial,
});

const plan = (input: Partial<PlanInput>) =>
  planSecurity({
    advisories: [],
    published: {},
    previous: { overrides: {}, releaseAgeExcludes: [], ignoredGhsas: [] },
    releaseAgeMinutes: 1440,
    now: NOW,
    ...input,
  });

describe('version ranges', () => {
  it('matches the comparator ranges advisories use', () => {
    expect(satisfiesComparators('4.2.0', '>=4.0.0 <4.3.2')).toBe(true);
    expect(satisfiesComparators('4.3.2', '>=4.0.0 <4.3.2')).toBe(false);
    expect(satisfiesComparators('3.15.2', '>=4.0.0 <4.3.2')).toBe(false);
    expect(satisfiesComparators('3.0.3', '<=3.0.3')).toBe(true);
    expect(satisfiesComparators('2.0.5', '<1.2.0 || >=2.0.0 <2.1.0')).toBe(true);
    expect(satisfiesComparators('1.5.0', '<1.2.0 || >=2.0.0 <2.1.0')).toBe(false);
  });

  it('calls a jump breaking when a caret range would not allow it', () => {
    expect(isBreakingJump('4.16.3', '7.0.2')).toBe(true);
    expect(isBreakingJump('4.2.0', '4.3.2')).toBe(false);
    expect(isBreakingJump('0.27.7', '0.28.1')).toBe(true);
    expect(isBreakingJump('0.27.7', '0.27.9')).toBe(false);
  });
});

describe('override keys', () => {
  it('treats a key with a version selector and no parent as audit output', () => {
    expect(isAuditOverride('braces@<=3.0.3')).toBe(true);
    expect(isAuditOverride('shell-quote@>=1.8.4 <1.11.0')).toBe(true);
    expect(isAuditOverride('@scope/pkg@<1.2.3')).toBe(true);
  });

  it('leaves a plain pin and a parent-scoped key to the developer', () => {
    expect(isAuditOverride('typescript')).toBe(false);
    expect(isAuditOverride('@scope/pkg')).toBe(false);
    expect(isAuditOverride('artillery>csv-parse')).toBe(false);
    expect(isAuditOverride('artillery@2>csv-parse@<7.0.2')).toBe(false);
  });

  it('names the package a key targets', () => {
    expect(overrideModule('shell-quote@>=1.8.4 <1.11.0')).toBe('shell-quote');
    expect(overrideModule('@scope/pkg@<1.2.3')).toBe('@scope/pkg');
    expect(overrideModule('artillery>csv-parse')).toBe('csv-parse');
  });

  it('splits a versioned release-age exclude and keeps a name-only one whole', () => {
    expect(parseVersionedExclude('moment@2.31.0')).toEqual({ name: 'moment', version: '2.31.0' });
    expect(parseVersionedExclude('@scope/pkg@1.0.0')).toEqual({ name: '@scope/pkg', version: '1.0.0' });
    expect(parseVersionedExclude('@cellajs/cli')).toBeNull();
    expect(parseVersionedExclude('moment')).toBeNull();
  });
});

describe('advisoriesFromAudit', () => {
  it('reads the installed versions and the dependencies that pull the package in', () => {
    const [found] = advisoriesFromAudit({
      advisories: {
        '1': {
          id: 1,
          module_name: 'braces',
          severity: 'high',
          vulnerable_versions: '<=3.0.3',
          url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
          github_advisory_id: 'GHSA-vfj7-8cjw-p6xm',
          findings: [
            { version: '3.0.3', paths: ['bench>artillery>chokidar>braces', 'frontend>vite-plugin-html>braces'] },
          ],
        },
      },
    });

    expect(found).toMatchObject({
      ghsa: 'GHSA-vfj7-8cjw-p6xm',
      module: 'braces',
      installed: ['3.0.3'],
      via: ['artillery', 'vite-plugin-html'],
      direct: false,
    });
  });
});

describe('planSecurity', () => {
  it('finds no fix when the patched version the advisory claims was never published', () => {
    const [item] = plan({
      advisories: [advisory({ ghsa: 'GHSA-braces', module: 'braces', range: '<=3.0.3', installed: ['3.0.3'] })],
      published: { braces: published(['3.0.1', '3.0.2', '3.0.3']) },
      previous: { overrides: { 'braces@<=3.0.3': '^3.0.4' }, releaseAgeExcludes: ['braces@3.0.4'], ignoredGhsas: [] },
    });

    expect(item.remedy).toEqual({ kind: 'none' });
    expect(item.standing).toBe('new');
    expect(item.overrides).toEqual({});
  });

  it('groups advisories with one fix into one item, with an override key per advisory range', () => {
    const [item, ...rest] = plan({
      advisories: [
        advisory({ ghsa: 'GHSA-a', module: 'js-yaml', range: '>=4.0.0 <4.3.0', installed: ['4.2.0'] }),
        advisory({ ghsa: 'GHSA-b', module: 'js-yaml', range: '>=4.0.0 <4.3.1', installed: ['4.2.0'] }),
        advisory({ ghsa: 'GHSA-c', module: 'js-yaml', range: '>=4.0.0 <4.3.2', installed: ['4.2.0'] }),
      ],
      published: { 'js-yaml': published(['3.15.2', '4.2.0', '4.3.0', '4.3.1', '4.3.2', '4.4.0']) },
      previous: { overrides: { 'js-yaml@>=4.0.0 <4.3.2': '^4.3.2' }, releaseAgeExcludes: [], ignoredGhsas: [] },
    });

    expect(rest).toEqual([]);
    expect(item.remedy).toEqual({ kind: 'override', target: '4.3.2', breaking: false });
    expect(item.standing).toBe('carried');
    expect(item.overrides).toEqual({
      'js-yaml@>=4.0.0 <4.3.0': '^4.3.2',
      'js-yaml@>=4.0.0 <4.3.1': '^4.3.2',
      'js-yaml@>=4.0.0 <4.3.2': '^4.3.2',
    });
  });

  it('carries a breaking override that was already in place, and keeps a hand-widened target', () => {
    const items = plan({
      advisories: [
        advisory({ ghsa: 'GHSA-csv', module: 'csv-parse', range: '<7.0.2', installed: ['4.16.3'] }),
        advisory({ ghsa: 'GHSA-esb', module: 'esbuild', range: '<0.28.1', installed: ['0.27.7'] }),
      ],
      published: {
        'csv-parse': published(['4.16.3', '5.6.0', '7.0.2', '7.0.3']),
        esbuild: published(['0.27.7', '0.28.1', '0.28.2']),
      },
      previous: {
        overrides: { 'csv-parse@<7.0.2': '^7.0.2', 'esbuild@<0.28.1': '>=0.28.1' },
        releaseAgeExcludes: [],
        ignoredGhsas: [],
      },
    });

    expect(items.map((item) => [item.module, item.standing, item.remedy.kind])).toEqual([
      ['csv-parse', 'carried', 'override'],
      ['esbuild', 'carried', 'override'],
    ]);
    expect(items[0].remedy).toMatchObject({ target: '7.0.2', breaking: true });
    expect(items[1].overrides).toEqual({ 'esbuild@<0.28.1': '>=0.28.1' });
  });

  it('marks a new breaking fix as new, for a decision', () => {
    const [item] = plan({
      advisories: [advisory({ ghsa: 'GHSA-csv', module: 'csv-parse', range: '<7.0.2', installed: ['4.16.3'] })],
      published: { 'csv-parse': published(['4.16.3', '7.0.2']) },
    });

    expect(item.standing).toBe('new');
    expect(item.remedy).toEqual({ kind: 'override', target: '7.0.2', breaking: true });
    expect(item.overrides).toEqual({ 'csv-parse@<7.0.2': '^7.0.2' });
  });

  it('holds back a fix younger than the release age, unless an exclude names it', () => {
    const input = {
      advisories: [advisory({ ghsa: 'GHSA-new', module: 'pkg', range: '<2.1.1', installed: ['2.1.0'] })],
      published: { pkg: published(['2.1.0', '2.1.1'], { '2.1.1': new Date(NOW - 5 * HOUR).toISOString() }) },
    };

    expect(plan(input)[0].remedy).toEqual({ kind: 'fresh', target: '2.1.1', breaking: false, hoursOld: 5 });

    const excluded = plan({
      ...input,
      previous: { overrides: {}, releaseAgeExcludes: ['pkg@2.1.1'], ignoredGhsas: [] },
    });
    expect(excluded[0].remedy.kind).toBe('override');
  });

  it('skips prereleases and versions inside another advisory range when picking the fix', () => {
    const [item] = plan({
      advisories: [
        advisory({ ghsa: 'GHSA-1', module: 'pkg', range: '<1.2.0', installed: ['1.1.0'] }),
        advisory({ ghsa: 'GHSA-2', module: 'pkg', range: '>=1.2.0 <1.2.2', installed: ['1.1.0'] }),
      ],
      published: { pkg: published(['1.1.0', '1.2.0', '1.2.2-beta.1', '1.2.2', '1.3.0']) },
    });

    expect(item.remedy).toMatchObject({ kind: 'override', target: '1.2.2' });
  });

  it('fixes what it can when no release escapes every advisory of a package', () => {
    const items = plan({
      advisories: [
        advisory({ ghsa: 'GHSA-old', module: 'pkg', range: '<2.0.0', installed: ['1.5.0'] }),
        advisory({ ghsa: 'GHSA-all', module: 'pkg', range: '<=2.1.0', installed: ['1.5.0'] }),
      ],
      published: { pkg: published(['1.5.0', '2.0.0', '2.1.0']) },
    });

    expect(items.map((item) => [item.ghsas, item.remedy.kind])).toEqual([
      [['GHSA-old'], 'override'],
      [['GHSA-all'], 'none'],
    ]);
    expect(items[0].overrides).toEqual({ 'pkg@<2.0.0': '^2.0.0' });
  });

  it('keeps the installable fix of one advisory while the fix of another is still too young', () => {
    const items = plan({
      advisories: [
        advisory({ ghsa: 'GHSA-old', module: 'pkg', range: '<7.0.2', installed: ['4.16.3'] }),
        advisory({ ghsa: 'GHSA-new', module: 'pkg', range: '<7.0.5', installed: ['4.16.3'] }),
      ],
      published: {
        pkg: published(['4.16.3', '7.0.2', '7.0.4', '7.0.5'], { '7.0.5': new Date(NOW - 3 * HOUR).toISOString() }),
      },
      previous: { overrides: { 'pkg@<7.0.2': '^7.0.2' }, releaseAgeExcludes: [], ignoredGhsas: [] },
    });

    expect(items.map((item) => [item.ghsas, item.remedy.kind, item.standing])).toEqual([
      [['GHSA-old'], 'override', 'carried'],
      [['GHSA-new'], 'fresh', 'new'],
    ]);
  });

  it('moves an ignored advisory to an override only once a compatible fix is published', () => {
    const base = {
      advisories: [advisory({ ghsa: 'GHSA-braces', module: 'braces', range: '<=3.0.3', installed: ['3.0.3'] })],
      previous: { overrides: {}, releaseAgeExcludes: [], ignoredGhsas: ['GHSA-braces'] },
    };

    const compatible = plan({ ...base, published: { braces: published(['3.0.3', '3.0.4']) } });
    expect(compatible[0]).toMatchObject({ standing: 'new', overrides: { 'braces@<=3.0.3': '^3.0.4' } });

    const breaking = plan({ ...base, published: { braces: published(['3.0.3', '4.0.0']) } });
    expect(breaking[0].standing).toBe('ignored');

    const unfixable = plan({ ...base, published: { braces: published(['3.0.3']) } });
    expect(unfixable[0].standing).toBe('ignored');
  });
});

describe('standingOverrides', () => {
  it('returns the audit overrides of a package whose target is published', () => {
    const input = {
      published: { pkg: published(['1.5.0', '2.0.0']), braces: published(['3.0.3']) },
      previous: {
        overrides: { 'pkg@<2.0.0': '^2.0.0', pkg: '1.5.0', 'braces@<=3.0.3': '^3.0.4', 'other@<1.0.0': '^1.0.0' },
        releaseAgeExcludes: [],
        ignoredGhsas: [],
      },
    };

    expect(standingOverrides('pkg', input)).toEqual({ 'pkg@<2.0.0': '^2.0.0' });
    expect(standingOverrides('braces', input)).toEqual({});
  });
});

describe('liveExcludes', () => {
  it('keeps name-only entries and versions still inside the release age', () => {
    const kept = liveExcludes({
      published: {
        moment: published(['2.31.0']),
        pkg: published(['2.1.1'], { '2.1.1': new Date(NOW - 5 * HOUR).toISOString() }),
        braces: published(['3.0.3']),
      },
      previous: {
        overrides: {},
        releaseAgeExcludes: ['@cellajs/cli', 'moment@2.31.0', 'pkg@2.1.1', 'braces@3.0.4', 'silent@1.0.0'],
        ignoredGhsas: [],
      },
      releaseAgeMinutes: 1440,
      now: NOW,
    });

    // moment has aged, braces@3.0.4 was never published; `silent` got no registry answer and stays.
    expect(kept).toEqual(['@cellajs/cli', 'pkg@2.1.1', 'silent@1.0.0']);
  });
});
