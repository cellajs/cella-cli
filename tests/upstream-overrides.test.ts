/**
 * Tests for upstream override changes.
 *
 * The sync config is managed (never merged), so entries upstream adds to its own
 * `overrides.pinned`/`overrides.ignored` never reach the fork. `parseOverrideLists` reads both
 * lists without evaluating the file, `diffOverrideLists` keeps what the fork config does not
 * follow, and `compareUpstreamOverrides` runs both against upstream's config at two refs.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellaCliConfig, MergeResult } from '../src/config/types';
import { printUpstreamOverrideChanges } from '../src/utils/display';
import { compareUpstreamOverrides, diffOverrideLists, parseOverrideLists } from '../src/utils/upstream-overrides';

/** A cella-style config with the given list bodies (raw source, so tests can embed comments). */
function configSource(pinned: string, ignored: string): string {
  return `import { defineConfig } from '@cellajs/cli/config';

export default defineConfig({
  settings: {
    upstreamUrl: 'git@github.com:cellajs/cella.git',
  },
  overrides: {
    // Paths the fork fully owns
    ignored: [${ignored}],
    pinned: [${pinned}],
  },
});
`;
}

function forkConfig(overrides: { pinned?: string[]; ignored?: string[] }): CellaCliConfig {
  return { settings: { upstreamUrl: 'test' }, overrides };
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
    });
  });

  it('reads empty lists when overrides or a list is absent', () => {
    expect(parseOverrideLists(`export default defineConfig({ settings: { upstreamUrl: 'x' } });`)).toEqual({
      pinned: [],
      ignored: [],
    });
    expect(parseOverrideLists(`export default defineConfig({ overrides: { pinned: ['a'] } });`)).toEqual({
      pinned: ['a'],
      ignored: [],
    });
  });

  it('follows same-file variables, satisfies and a plain default export', () => {
    const viaVariable = `
      const ignored = ['own'];
      const overrides = { ignored, 'pinned': ['a.ts', ...extra] };
      export default defineConfig({ settings, overrides });
    `;
    expect(parseOverrideLists(viaVariable)).toEqual({ pinned: ['a.ts'], ignored: ['own'] });

    const plain = `export default ({ overrides: { pinned: ['b.ts'] } }) satisfies CellaCliConfig;`;
    expect(parseOverrideLists(plain)).toEqual({ pinned: ['b.ts'], ignored: [] });
  });

  it('returns null when the config cannot be read statically', () => {
    expect(parseOverrideLists('this is { not a config')).toBeNull();
    expect(parseOverrideLists('export default defineConfig(buildConfig());')).toBeNull();
    expect(parseOverrideLists('export default defineConfig({ overrides: makeOverrides() });')).toBeNull();
    expect(parseOverrideLists('export default defineConfig({ overrides: { pinned: list() } });')).toBeNull();
  });
});

describe('diffOverrideLists', () => {
  const base = { pinned: ['a.ts', 'b.ts', 'gone.ts'], ignored: ['README.md', 'old'] };
  const incoming = {
    pinned: ['a.ts', 'b.ts', 'backend/src/bundle-config.ts'],
    ignored: ['README.md', 'shared/config/'],
  };

  it('reports upstream additions the fork lacks and removals the fork still carries', () => {
    const fork = { pinned: ['a.ts', 'gone.ts'], ignored: ['README.md', 'old/'] };
    expect(diffOverrideLists(base, incoming, fork)).toEqual({
      pinned: { added: ['backend/src/bundle-config.ts'], removed: ['gone.ts'] },
      ignored: { added: ['shared/config'], removed: ['old'] },
    });
  });

  it('skips additions the fork already covers, by entry or parent folder', () => {
    const fork = { pinned: ['backend/src/bundle-config.ts'], ignored: ['shared'] };
    expect(diffOverrideLists(base, incoming, fork)).toEqual({
      pinned: { added: [], removed: [] },
      ignored: { added: [], removed: [] },
    });
  });

  it('never reports entries upstream had all along, whether the fork has them or not', () => {
    // 'a.ts' is in both upstream refs and the fork; 'b.ts' in both upstream refs, dropped by the fork
    const result = diffOverrideLists(base, incoming, { pinned: ['a.ts'], ignored: [] });
    expect(result.pinned.added).not.toContain('a.ts');
    expect(result.pinned.added).not.toContain('b.ts');
    expect(result.pinned.removed).toEqual([]);
  });
});

describe('compareUpstreamOverrides', () => {
  let repoPath: string;

  function exec(cmd: string): string {
    return execSync(cmd, { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  /** Commit `files` (null deletes) and return the commit sha. */
  function commit(files: Record<string, string | null>): string {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(repoPath, file);
      if (content === null) {
        fs.rmSync(full, { force: true });
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }
    exec('git add -A && git commit -q --allow-empty -m step');
    return exec('git rev-parse HEAD');
  }

  function createRepo(): void {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-upstream-overrides-'));
    exec('git init -q -b main');
    exec('git config user.email "test@test.com" && git config user.name "Test"');
  }

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('reports what upstream added and removed since the merge-base', async () => {
    createRepo();
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
    });
  });

  it('reads the legacy root config path at an older merge-base', async () => {
    createRepo();
    const base = commit({ 'cella.config.ts': configSource(`'a.ts'`, '') });
    const incoming = commit({ 'cella.config.ts': null, 'cella/cella.config.ts': configSource(`'a.ts', 'b.ts'`, '') });

    const report = await compareUpstreamOverrides(repoPath, base, incoming, forkConfig({ pinned: ['a.ts'] }));
    expect(report).toMatchObject({ kind: 'changes', pinned: { added: ['b.ts'] } });
  });

  it('stays silent when upstream has no config, it did not change, or the fork already follows', async () => {
    createRepo();
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
    createRepo();
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
  function capture(upstreamOverrides: MergeResult['upstreamOverrides']): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      printUpstreamOverrideChanges({ upstreamOverrides } as MergeResult);
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('lists added and removed entries by name', () => {
    const out = capture({
      kind: 'changes',
      pinned: { added: ['backend/src/bundle-config.ts'], removed: [] },
      ignored: { added: ['infra/Pulumi.staging.yaml'], removed: ['old'] },
    });
    expect(out).toContain('upstream changed its sync overrides · 3 entries to review');
    expect(out).toContain('+ pinned: backend/src/bundle-config.ts');
    expect(out).toContain('+ ignored: infra/Pulumi.staging.yaml');
    expect(out).toContain('− ignored: old');
    expect(out).toContain('dropped upstream, still in your config');
    expect(out).toContain('cella/cella.config.ts never syncs');
  });

  it('prints one dim line when upstream config was unreadable, nothing when there is no report', () => {
    const unreadable = capture({ kind: 'unreadable', side: 'incoming' });
    expect(unreadable.trim().split('\n')).toHaveLength(1);
    expect(unreadable).toContain('upstream overrides not compared');
    expect(capture(undefined)).toBe('');
  });
});
