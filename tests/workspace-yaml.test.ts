import { describe, expect, it } from 'vitest';
import { readAuditSettings, readPatchFiles, writeAuditSettings } from '../src/utils/workspace-yaml';

/** Shaped like a workspace file pnpm maintains: sorted settings, plain scalars where YAML allows. */
const SORTED = `---
allowBuilds:
  esbuild: true
auditConfig:
  ignoreGhsas:
    - GHSA-vfj7-8cjw-p6xm
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - '@cellajs/cli'
  - moment@2.31.0
overrides:
  csv-parse@<7.0.2: ^7.0.2
  shell-quote@>=1.8.4 <1.11.0: ^1.11.0
packages:
  - backend
patchedDependencies:
  artillery@2.0.34: patches/artillery@2.0.34.patch
`;

/** Shaped like a hand-written one: comments, quotes, its own order. */
const HAND_WRITTEN = `# Supply-chain guard.
minimumReleaseAge: 1440

overrides:
  # esbuild advisory
  'esbuild@<0.28.1': '>=0.28.1'

allowBuilds:
  esbuild: true
`;

describe('readAuditSettings', () => {
  it('reads overrides, release-age excludes and ignored advisories', () => {
    expect(readAuditSettings(SORTED)).toEqual({
      overrides: { 'csv-parse@<7.0.2': '^7.0.2', 'shell-quote@>=1.8.4 <1.11.0': '^1.11.0' },
      releaseAgeExcludes: ['@cellajs/cli', 'moment@2.31.0'],
      ignoredGhsas: ['GHSA-vfj7-8cjw-p6xm'],
    });
  });

  it('reads missing blocks, and an empty file, as empty', () => {
    const empty = { overrides: {}, releaseAgeExcludes: [], ignoredGhsas: [] };
    expect(readAuditSettings(HAND_WRITTEN).releaseAgeExcludes).toEqual([]);
    expect(readAuditSettings('')).toEqual(empty);
    expect(readAuditSettings('auditConfig: {}\n')).toEqual(empty);
  });

  it('throws on content that is not YAML', () => {
    expect(() => readAuditSettings('overrides:\n  a: [1\n')).toThrow();
  });

  it('lists the patch files a resolve needs', () => {
    expect(readPatchFiles(SORTED)).toEqual(['patches/artillery@2.0.34.patch']);
  });
});

describe('writeAuditSettings', () => {
  it('returns the content byte for byte when nothing changes', () => {
    expect(writeAuditSettings(SORTED, readAuditSettings(SORTED))).toBe(SORTED);
    expect(writeAuditSettings(HAND_WRITTEN, readAuditSettings(HAND_WRITTEN))).toBe(HAND_WRITTEN);
  });

  it('removes and adds entries in place, new keys in sorted position and quoted where YAML needs it', () => {
    const next = writeAuditSettings(SORTED, {
      overrides: {
        'shell-quote@>=1.8.4 <1.11.0': '^1.11.0',
        '@scope/pkg@<1.2.3': '^1.2.3',
        'esbuild@<0.28.1': '^0.28.1',
      },
      releaseAgeExcludes: ['@cellajs/cli'],
      ignoredGhsas: ['GHSA-vfj7-8cjw-p6xm', 'GHSA-hp3w-g68c-fv3c'],
    });

    expect(next).toContain(`overrides:
  '@scope/pkg@<1.2.3': ^1.2.3
  esbuild@<0.28.1: ^0.28.1
  shell-quote@>=1.8.4 <1.11.0: ^1.11.0
packages:`);
    expect(next).toContain(`minimumReleaseAgeExclude:
  - '@cellajs/cli'
overrides:`);
    expect(next).toContain(`  ignoreGhsas:
    - GHSA-vfj7-8cjw-p6xm
    - GHSA-hp3w-g68c-fv3c
`);
  });

  it('drops a block that ends up empty, and an auditConfig left without keys', () => {
    const next = writeAuditSettings(SORTED, { overrides: {}, releaseAgeExcludes: [], ignoredGhsas: [] });

    expect(next).not.toMatch(/overrides|minimumReleaseAgeExclude|auditConfig/);
    expect(next).toContain('minimumReleaseAge: 1440\npackages:');
  });

  it('creates missing blocks: sorted into a sorted file, last in a hand-ordered one', () => {
    const ignoredGhsas = ['GHSA-aaaa-bbbb-cccc'];
    const sorted = 'allowBuilds:\n  esbuild: true\npackages:\n  - backend\n';

    expect(writeAuditSettings(sorted, { ...readAuditSettings(sorted), ignoredGhsas })).toBe(
      'allowBuilds:\n  esbuild: true\nauditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc\npackages:\n  - backend\n',
    );
    expect(writeAuditSettings(HAND_WRITTEN, { ...readAuditSettings(HAND_WRITTEN), ignoredGhsas })).toBe(
      `${HAND_WRITTEN}auditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc\n`,
    );
  });

  it('keeps comments and quoting of the entries it leaves alone', () => {
    const next = writeAuditSettings(HAND_WRITTEN, {
      overrides: { 'esbuild@<0.28.1': '>=0.28.1', 'braces@<=3.0.3': '^3.0.4' },
      releaseAgeExcludes: [],
      ignoredGhsas: [],
    });

    expect(next).toContain('# Supply-chain guard.\nminimumReleaseAge: 1440\n\noverrides:\n  # esbuild advisory\n');
    expect(next).toContain("  'esbuild@<0.28.1': '>=0.28.1'\n");
    expect(next).toContain('  braces@<=3.0.3: ^3.0.4\n');
  });

  it('fills an empty inline auditConfig as a block', () => {
    const next = writeAuditSettings('auditConfig: {}\n', {
      overrides: {},
      releaseAgeExcludes: [],
      ignoredGhsas: ['GHSA-aaaa-bbbb-cccc'],
    });

    expect(next).toBe('auditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc\n');
  });
});
