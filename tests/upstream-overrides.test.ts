/**
 * Tests for upstream override changes.
 *
 * The sync config is managed (never merged), so entries upstream adds to its own
 * `overrides.pinned`/`overrides.ignored`, and keys it adds to `settings.packageJsonKeys`, never
 * reach the fork. `parseOverrideLists` reads the lists without evaluating the file,
 * `diffOverrideLists` keeps what the fork config does not follow, and `compareUpstreamOverrides`
 * runs both against upstream's config at two refs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CellaCliConfig, MergeResult, PackageJsonKey } from '../src/config/types';
import { printUpstreamOverrideChanges } from '../src/utils/display';
import { compareUpstreamOverrides, diffOverrideLists, parseOverrideLists } from '../src/utils/upstream-overrides';
import { captureInfo, createRepo, exec, write } from './helpers/test-env';

/** The keys a config without `packageJsonKeys` syncs. */
const DEFAULT_KEYS = ['dependencies', 'devDependencies'];

/** No change in one list. */
const NONE = { added: [], removed: [] };

/**
 * A cella-style config with the given list bodies (raw source, so tests can embed comments).
 * `settings` adds raw lines to the settings object, e.g. a `packageJsonKeys` list.
 */
function configSource(pinned: string, ignored: string, settings = ''): string {
  return `import { defineConfig } from '@cellajs/cli/config';

export default defineConfig({
  settings: {
    upstreamUrl: 'git@github.com:cellajs/cella.git',
    ${settings}
  },
  overrides: {
    // Paths the fork fully owns
    ignored: [${ignored}],
    pinned: [${pinned}],
  },
});
`;
}

function forkConfig(
  overrides: { pinned?: string[]; ignored?: string[] },
  packageJsonKeys?: PackageJsonKey[],
): CellaCliConfig {
  return { settings: { upstreamUrl: 'test', packageJsonKeys }, overrides };
}

describe('parseOverrideLists', () => {
  it('reads string entries and skips comments inside the arrays', () => {
    const source = configSource(
      `
      // Attachment seam: app-filled
      'backend/src/modules.ts',
      /* block comment */ "frontend/src/menu-config.tsx",
      \`json/text-blocks.json\`, // trailing comment
    `,
      `
      'README.md',
      // 'commented/out',
      'shared/config',
    `,
    );
    expect(parseOverrideLists(source)).toEqual({
      pinned: ['backend/src/modules.ts', 'frontend/src/menu-config.tsx', 'json/text-blocks.json'],
      ignored: ['README.md', 'shared/config'],
      packageJsonKeys: DEFAULT_KEYS,
    });
  });

  it('reads empty lists when overrides or a list is absent', () => {
    expect(parseOverrideLists(`export default defineConfig({ settings: { upstreamUrl: 'x' } });`)).toEqual({
      pinned: [],
      ignored: [],
      packageJsonKeys: DEFAULT_KEYS,
    });
    expect(parseOverrideLists(`export default defineConfig({ overrides: { pinned: ['a'] } });`)).toEqual({
      pinned: ['a'],
      ignored: [],
      packageJsonKeys: DEFAULT_KEYS,
    });
  });

  it('reads the packageJsonKeys keys, and null when settings or the list cannot be read statically', () => {
    const source = configSource(
      `'a.ts'`,
      '',
      `packageJsonKeys: ['dependencies', 'scripts', /* add-only */ 'exports'],`,
    );
    expect(parseOverrideLists(source)?.packageJsonKeys).toEqual(['dependencies', 'scripts', 'exports']);

    // An unreadable key list leaves the override lists readable
    const computed = configSource(`'a.ts'`, '', 'packageJsonKeys: keys(),');
    expect(parseOverrideLists(computed)).toEqual({ pinned: ['a.ts'], ignored: [], packageJsonKeys: null });
  });

  it('follows same-file variables, satisfies and a plain default export', () => {
    const viaVariable = `
      const ignored = ['own'];
      const overrides = { ignored, 'pinned': ['a.ts', ...extra] };
      export default defineConfig({ settings, overrides });
    `;
    // `settings` is imported, so its packageJsonKeys is unknown
    expect(parseOverrideLists(viaVariable)).toEqual({ pinned: ['a.ts'], ignored: ['own'], packageJsonKeys: null });

    const plain = `export default ({ overrides: { pinned: ['b.ts'] } }) satisfies CellaCliConfig;`;
    expect(parseOverrideLists(plain)).toEqual({ pinned: ['b.ts'], ignored: [], packageJsonKeys: DEFAULT_KEYS });
  });

  it('returns null when the config cannot be read statically', () => {
    expect(parseOverrideLists('this is { not a config')).toBeNull();
    expect(parseOverrideLists('export default defineConfig(buildConfig());')).toBeNull();
    expect(parseOverrideLists('export default defineConfig({ overrides: makeOverrides() });')).toBeNull();
    expect(parseOverrideLists('export default defineConfig({ overrides: { pinned: list() } });')).toBeNull();
  });
});

describe('diffOverrideLists', () => {
  const base = { pinned: ['a.ts', 'b.ts', 'gone.ts'], ignored: ['README.md', 'old'], packageJsonKeys: DEFAULT_KEYS };
  const incoming = {
    pinned: ['a.ts', 'b.ts', 'backend/src/bundle-config.ts'],
    ignored: ['README.md', 'shared/config/'],
    packageJsonKeys: DEFAULT_KEYS,
  };

  it('reports upstream additions the fork lacks and removals the fork still carries', () => {
    const fork = { pinned: ['a.ts', 'gone.ts'], ignored: ['README.md', 'old/'], packageJsonKeys: DEFAULT_KEYS };
    expect(diffOverrideLists(base, incoming, fork)).toEqual({
      pinned: { added: ['backend/src/bundle-config.ts'], removed: ['gone.ts'] },
      ignored: { added: ['shared/config'], removed: ['old'] },
      packageJsonKeys: NONE,
    });
  });

  it('skips additions the fork already covers, by entry or parent folder', () => {
    const fork = { pinned: ['backend/src/bundle-config.ts'], ignored: ['shared'], packageJsonKeys: DEFAULT_KEYS };
    expect(diffOverrideLists(base, incoming, fork)).toEqual({ pinned: NONE, ignored: NONE, packageJsonKeys: NONE });
  });

  it('never reports entries upstream had all along, whether the fork has them or not', () => {
    // 'a.ts' is in both upstream refs and the fork; 'b.ts' in both upstream refs, dropped by the fork
    const result = diffOverrideLists(base, incoming, { pinned: ['a.ts'], ignored: [], packageJsonKeys: [] });
    expect(result.pinned.added).not.toContain('a.ts');
    expect(result.pinned.added).not.toContain('b.ts');
    expect(result.pinned.removed).toEqual([]);
    // the default keys are in both upstream refs, the fork syncs none of them
    expect(result.packageJsonKeys).toEqual(NONE);
  });

  it('reports packageJsonKeys keys upstream added that the fork lacks and dropped that the fork still lists', () => {
    const lists = (packageJsonKeys: string[] | null) => ({ pinned: [], ignored: [], packageJsonKeys });
    const before = lists(['dependencies', 'devDependencies', 'engines']);
    const after = lists(['dependencies', 'devDependencies', 'scripts', 'exports']);

    expect(diffOverrideLists(before, after, lists(['dependencies', 'scripts', 'engines'])).packageJsonKeys).toEqual({
      added: ['exports'],
      removed: ['engines'],
    });
    // a side that could not be read compares nothing
    expect(diffOverrideLists(before, lists(null), lists(['dependencies'])).packageJsonKeys).toEqual(NONE);
    expect(diffOverrideLists(before, after, lists(null)).packageJsonKeys).toEqual(NONE);
  });
});

describe('compareUpstreamOverrides', () => {
  let repoPath: string;

  /** Commit `files` (null deletes) and return the commit sha. */
  function commit(files: Record<string, string | null>): string {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        fs.rmSync(path.join(repoPath, file), { force: true });
      } else {
        write(repoPath, { [file]: content });
      }
    }
    exec('git add -A && git commit -q --allow-empty -m step', repoPath);
    return exec('git rev-parse HEAD', repoPath);
  }

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('reports what upstream added and removed since the merge-base', async () => {
    repoPath = createRepo('cella-upstream-overrides-');
    const base = commit({ 'cella/cella.config.ts': configSource(`'a.ts'`, `'README.md', 'old'`) });
    const incoming = commit({
      'cella/cella.config.ts': configSource(
        `'a.ts',\n // Bundle composition is app-owned\n 'backend/src/bundle-config.ts'`,
        `'README.md'`,
      ),
    });

    const report = await compareUpstreamOverrides(
      repoPath,
      base,
      incoming,
      forkConfig({ pinned: ['a.ts'], ignored: ['README.md', 'old'] }),
    );
    expect(report).toEqual({
      kind: 'changes',
      pinned: { added: ['backend/src/bundle-config.ts'], removed: [] },
      ignored: { added: [], removed: ['old'] },
      packageJsonKeys: NONE,
    });
  });

  it('reports a packageJsonKeys key upstream added, against the default when the fork config names none', async () => {
    repoPath = createRepo('cella-upstream-overrides-');
    const base = commit({ 'cella/cella.config.ts': configSource(`'a.ts'`, '') });
    const incoming = commit({
      'cella/cella.config.ts': configSource(
        `'a.ts'`,
        '',
        `packageJsonKeys: ['dependencies', 'devDependencies', 'exports'],`,
      ),
    });

    const fork = forkConfig({ pinned: ['a.ts'] });
    expect(await compareUpstreamOverrides(repoPath, base, incoming, fork)).toEqual({
      kind: 'changes',
      pinned: NONE,
      ignored: NONE,
      packageJsonKeys: { added: ['exports'], removed: [] },
    });

    const following = forkConfig({ pinned: ['a.ts'] }, ['dependencies', 'exports']);
    expect(await compareUpstreamOverrides(repoPath, base, incoming, following)).toBeUndefined();
  });

  it('stays silent when upstream has no config, it did not change, or the fork already follows', async () => {
    repoPath = createRepo('cella-upstream-overrides-');
    const empty = commit({ 'other.ts': 'a' });
    const alsoEmpty = commit({ 'other.ts': 'b' });
    expect(await compareUpstreamOverrides(repoPath, empty, alsoEmpty, forkConfig({}))).toBeUndefined();

    const withConfig = commit({ 'cella/cella.config.ts': configSource(`'a.ts'`, '') });
    const unchanged = commit({ 'other.ts': 'c' });
    expect(await compareUpstreamOverrides(repoPath, withConfig, unchanged, forkConfig({}))).toBeUndefined();

    const added = commit({ 'cella/cella.config.ts': configSource(`'a.ts', 'b.ts'`, '') });
    const followed = forkConfig({ pinned: ['a.ts', 'b.ts'] });
    expect(await compareUpstreamOverrides(repoPath, withConfig, added, followed)).toBeUndefined();
  });

  it('degrades to unreadable when the config is missing or unparsable at one side', async () => {
    repoPath = createRepo('cella-upstream-overrides-');
    const missing = commit({ 'other.ts': 'a' });
    const present = commit({ 'cella/cella.config.ts': configSource(`'a.ts'`, '') });
    const broken = commit({ 'cella/cella.config.ts': 'export default buildConfig(' });

    expect(await compareUpstreamOverrides(repoPath, missing, present, forkConfig({}))).toEqual({
      kind: 'unreadable',
      side: 'base',
    });
    expect(await compareUpstreamOverrides(repoPath, present, broken, forkConfig({}))).toEqual({
      kind: 'unreadable',
      side: 'incoming',
    });
  });
});

describe('printUpstreamOverrideChanges', () => {
  const capture = (upstreamOverrides: MergeResult['upstreamOverrides']) =>
    captureInfo(() => printUpstreamOverrideChanges({ upstreamOverrides }));

  it('lists added and removed entries by name', () => {
    const out = capture({
      kind: 'changes',
      pinned: { added: ['backend/src/bundle-config.ts'], removed: [] },
      ignored: { added: ['infra/Pulumi.staging.yaml'], removed: ['old'] },
      packageJsonKeys: { added: ['exports'], removed: ['engines'] },
    });
    expect(out).toContain('upstream changed its CLI config · 5 entries to review');
    expect(out).toContain('+ pinned: backend/src/bundle-config.ts');
    expect(out).toContain('+ ignored: infra/Pulumi.staging.yaml');
    expect(out).toContain('− ignored: old');
    expect(out).toContain('+ packageJsonKeys: exports');
    expect(out).toContain('− packageJsonKeys: engines');
    expect(out).toContain('dropped upstream, still in your config');
    expect(out).toContain('cella/cella.config.ts never merges');
  });

  it('prints one dim line when upstream config was unreadable, nothing when there is no report', () => {
    const unreadable = capture({ kind: 'unreadable', side: 'incoming' });
    expect(unreadable.trim().split('\n')).toHaveLength(1);
    expect(unreadable).toContain('upstream CLI config not compared');
    expect(capture(undefined)).toBe('');
  });
});
