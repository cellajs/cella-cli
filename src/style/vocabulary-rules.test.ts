import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../../tests/helpers/style-repo';
import { loadExceptions, templateExceptions } from './exceptions';
import { styleRules } from './index';
import { productNameRule, sourceControlTermRule } from './vocabulary-rules';

const legacyTerm = ['fo', 'rk'].join('');

describe('source-control-term', () => {
  it('finds the term in prose, casing, plurals, and identifiers', () => {
    const source = [
      `// ${legacyTerm}-owned`,
      `const ${legacyTerm}Breaking = true`,
      legacyTerm.toUpperCase(),
      `${legacyTerm}s`,
    ].join('\n');

    expect(check([sourceControlTermRule], 'example.ts', source).map(({ line, term }) => ({ line, term }))).toEqual([
      { line: 1, term: legacyTerm },
      { line: 2, term: legacyTerm },
      { line: 3, term: legacyTerm.toUpperCase() },
      { line: 4, term: legacyTerm },
    ]);
  });

  it('skips the upgrade marker comments but not the term elsewhere on the same lines', () => {
    const source = [
      `const a = 1; // ${legacyTerm}: keeps the app's default`,
      `/* ${legacyTerm}: multi`,
      `   line */ const ${legacyTerm}Config = {};`,
      `<!-- ${legacyTerm}: app copy -->`,
      '/**',
      ` * ${legacyTerm}: the app keeps its own default`,
      ` * and a ${legacyTerm} word on a later line still counts`,
      ' */',
    ].join('\n');

    expect(
      check([sourceControlTermRule], 'example.ts', source).map(({ line, column, term }) => ({ line, column, term })),
    ).toEqual([
      { line: 3, column: 18, term: legacyTerm },
      { line: 7, column: 10, term: legacyTerm },
    ]);
  });

  it('skips a YAML marker line, in YAML only', () => {
    const source = [
      `  '@babel/traverse': 7.29.0 # ${legacyTerm}: pinned until the upstream fix`,
      `  # ${legacyTerm}: the app's own catalog`,
    ].join('\n');

    expect(check([sourceControlTermRule], 'pnpm-workspace.yaml', source)).toEqual([]);
    expect(check([sourceControlTermRule], 'example.ts', `class A { #${legacyTerm}: string }`)).toHaveLength(1);
    // Inside a value a `#` starts no comment
    expect(check([sourceControlTermRule], 'pnpm-workspace.yaml', `key: abc#${legacyTerm}: value`)).toHaveLength(1);
  });

  it('finds the term in a file path', () => {
    const findings = check([sourceControlTermRule], `src/${legacyTerm}-config.ts`, 'export {};');

    expect(findings).toEqual([
      {
        file: `src/${legacyTerm}-config.ts`,
        rule: 'source-control-term',
        term: legacyTerm,
        message: 'use template/app terminology',
      },
    ]);
  });

  it('allows the Cella CLI configuration', () => {
    expect(check([sourceControlTermRule], 'cella/cella.config.ts', legacyTerm)).toEqual([]);
  });

  it('allows the release-please changelogs, template and app root alike', () => {
    expect(check([sourceControlTermRule], 'cella/CHANGELOG.md', legacyTerm)).toEqual([]);
    expect(check([sourceControlTermRule], 'CHANGELOG.md', legacyTerm)).toEqual([]);
  });
});

describe('product-name', () => {
  const name = ['cel', 'la'].join('');

  it('finds the product name in identifiers, claims, DNS records and URLs of app logic', () => {
    const source = [
      `const claim = '${name}_kind';`,
      `type ${name[0].toUpperCase()}${name.slice(1)}TokenClaims = {};`,
      `const host = \`_${name}-verification.\${domain}\`;`,
      `const url = 'https://www.${name}js.com/mcp';`,
    ].join('\n');
    expect(
      check([productNameRule], 'backend/src/modules/x/x.ts', source).map(({ line, term }) => ({ line, term })),
    ).toEqual([
      { line: 1, term: `${name}_k` },
      { line: 2, term: 'CellaT' },
      { line: 3, term: `_${name}-` },
      { line: 4, term: `${name}js.com` },
    ]);
  });

  it('leaves prose, tags and ownership markers alone', () => {
    const source = [
      `// none in ${name}; apps with other vocabularies add theirs`,
      `tags: ['me', '${name}'],`,
      `owner: '${name}',`,
    ].join('\n');
    expect(check([productNameRule], 'backend/src/modules/x/x.ts', source)).toEqual([]);
  });

  it('covers logic roots only, never tests, config, docs or the marketing site', () => {
    const source = `const url = 'https://www.${name}js.com';`;
    expect(check([productNameRule], 'backend/src/x.test.ts', source)).toEqual([]);
    expect(check([productNameRule], 'shared/config/config.default.ts', source)).toEqual([]);
    expect(check([productNameRule], 'frontend/src/modules/marketing/about.tsx', source)).toEqual([]);
    expect(check([productNameRule], 'frontend/src/content/docs/x.mdx', source)).toEqual([]);
    expect(check([productNameRule], 'infra/lib/x.ts', source)).toEqual([]);
    expect(check([productNameRule], 'frontend/src/modules/me/x.tsx', source)).toHaveLength(1);
  });
});

describe('loadExceptions', () => {
  const ids = styleRules.map((rule) => rule.id);
  const appRepo = (file: string, source: string) => {
    const root = mkdtempSync(join(tmpdir(), 'style-exceptions-'));
    mkdirSync(join(root, 'shared/config'), { recursive: true });
    writeFileSync(join(root, 'shared/config', file), source);
    return root;
  };

  it('merges the app-owned file into the template exceptions', async () => {
    const root = appRepo(
      'style-exceptions.ts',
      "export const styleExceptions = { exempt: { 'source-control-term': ['json/icons.json'] }, markerClasses: ['hook'] };\n",
    );
    const { exempt, markerClasses } = await loadExceptions(root, ids);
    expect(exempt['source-control-term']).toEqual(expect.arrayContaining(['cella/CHANGELOG.md', 'json/icons.json']));
    expect(markerClasses).toEqual(['is-selected', 'hook']);
  });

  it('refuses a rule id no rule has and a key the shape lacks', async () => {
    const unknownRule = appRepo(
      'style-exceptions.ts',
      "export const styleExceptions = { exempt: { 'no-rule': [] } };\n",
    );
    await expect(loadExceptions(unknownRule, ids)).rejects.toThrow(/no rule named no-rule/);
    const unknownKey = appRepo('style-exceptions.ts', 'export const styleExceptions = { prefixes: [] };\n');
    await expect(loadExceptions(unknownKey, ids)).rejects.toThrow(/exports no valid styleExceptions/);
  });

  it('maps the 0.7 allowlist: files and prefixes to the source-control term, proseExclude to every prose rule', async () => {
    const root = appRepo(
      'vocabulary-allowlist.ts',
      "export const vocabularyAllowlist = { files: ['json/icons.json'], prefixes: ['generated/'], proseExclude: ['old/'], markerClasses: { hook: 'why' } };\n",
    );
    const { exempt, markerClasses } = await loadExceptions(root, ids);
    expect(exempt['source-control-term']).toEqual(expect.arrayContaining(['json/icons.json', 'generated/']));
    expect(exempt['em-dash']).toEqual(['old/']);
    expect(exempt['detached-long-comment']).toEqual(['old/']);
    expect(markerClasses).toEqual(['is-selected', 'hook']);
  });

  it('falls back to the template exceptions without an app file', async () => {
    expect(await loadExceptions(mkdtempSync(join(tmpdir(), 'style-exceptions-')), ids)).toEqual(templateExceptions);
  });
});
