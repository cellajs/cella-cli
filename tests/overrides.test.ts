/**
 * Unit tests for override matching utilities.
 *
 * Tests isIgnored, isPinned, and isUnderAnyFolder with the
 * shared path-or-folder-prefix model, the grouping of protected paths by entry, and the config
 * validation warnings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CellaCliConfig } from '../src/config/types';
import { isManagedFile } from '../src/utils/managed-files';
import {
  groupProtectedUpstreamChanges,
  isIgnored,
  isPinned,
  isUnderAnyFolder,
  validateOverrides,
} from '../src/utils/overrides';
import { createTestEnv, deleteFileAndCommit, fetchUpstream, makeCommit, type TestEnv } from './e2e/helpers/test-env';

/** Helper to build a minimal config with overrides */
function buildConfig(overrides: { pinned?: string[]; ignored?: string[] }): CellaCliConfig {
  return {
    settings: {
      upstreamUrl: 'test',
      upstreamBranch: 'main',
    },
    overrides: {
      pinned: overrides.pinned ?? [],
      ignored: overrides.ignored ?? [],
    },
  };
}

describe('overrides', () => {
  describe('isUnderAnyFolder', () => {
    it('should match files nested under a folder', () => {
      expect(isUnderAnyFolder('docs/guide.md', ['docs'])).toBe(true);
      expect(isUnderAnyFolder('docs/api/ref.md', ['docs'])).toBe(true);
    });

    it('should match an exact path entry', () => {
      expect(isUnderAnyFolder('README.md', ['README.md'])).toBe(true);
      expect(isUnderAnyFolder('READMExmd', ['README.md'])).toBe(false);
    });

    it('should tolerate trailing slashes on entries', () => {
      expect(isUnderAnyFolder('bench/run.ts', ['bench/'])).toBe(true);
    });

    it('should not match unrelated or prefix-only paths', () => {
      expect(isUnderAnyFolder('src/index.ts', ['docs'])).toBe(false);
      expect(isUnderAnyFolder('docs-extra/file.ts', ['docs'])).toBe(false);
    });
  });

  describe('isIgnored', () => {
    it('should match files inside ignored folders', () => {
      const config = buildConfig({ ignored: ['docs', 'test'] });
      expect(isIgnored('docs/guide.md', config)).toBe(true);
      expect(isIgnored('docs/api/ref.md', config)).toBe(true);
      expect(isIgnored('test/unit.ts', config)).toBe(true);
      expect(isIgnored('src/index.ts', config)).toBe(false);
    });

    it('should return false with empty ignored list', () => {
      const config = buildConfig({ ignored: [] });
      expect(isIgnored('any/file.ts', config)).toBe(false);
    });

    it('should handle exact path in ignored folders', () => {
      const config = buildConfig({ ignored: ['cella/cella.config.ts'] });
      expect(isIgnored('cella/cella.config.ts', config)).toBe(true);
      expect(isIgnored('other.config.ts', config)).toBe(false);
    });
  });

  describe('isPinned', () => {
    it('should match exact pinned files', () => {
      const config = buildConfig({ pinned: ['backend/src/index.ts', 'frontend/src/app.tsx'] });
      expect(isPinned('backend/src/index.ts', config)).toBe(true);
      expect(isPinned('frontend/src/app.tsx', config)).toBe(true);
      expect(isPinned('backend/src/utils.ts', config)).toBe(false);
    });

    it('should match files nested under pinned folders', () => {
      const config = buildConfig({ pinned: ['frontend/src/modules/home'] });
      expect(isPinned('frontend/src/modules/home/home-page.tsx', config)).toBe(true);
      expect(isPinned('frontend/src/modules/home/onboarding/onboarding-config.ts', config)).toBe(true);
      expect(isPinned('frontend/src/modules/marketing/logo.tsx', config)).toBe(false);
    });

    it('should auto-pin managed files', () => {
      const config = buildConfig({ pinned: [] });
      expect(isPinned('package.json', config)).toBe(true);
      expect(isPinned('frontend/package.json', config)).toBe(true);
      expect(isPinned('pnpm-lock.yaml', config)).toBe(true);
      expect(isPinned('cella/cella.config.ts', config)).toBe(true);
    });

    it('should identify managed files', () => {
      expect(isManagedFile('package.json')).toBe(true);
      expect(isManagedFile('frontend/package.json')).toBe(true);
      expect(isManagedFile('pnpm-lock.yaml')).toBe(true);
      expect(isManagedFile('cella/cella.config.ts')).toBe(true);
      expect(isManagedFile('frontend/src/index.ts')).toBe(false);
    });

    it('should return false with empty pinned list', () => {
      const config = buildConfig({ pinned: [] });
      expect(isPinned('any/file.ts', config)).toBe(false);
    });

    it('should return false with undefined overrides', () => {
      const config: CellaCliConfig = {
        settings: {
          upstreamUrl: 'test',
          upstreamBranch: 'main',
        },
      };
      expect(isPinned('any/file.ts', config)).toBe(false);
      expect(isIgnored('any/file.ts', config)).toBe(false);
    });
  });

  describe('groupProtectedUpstreamChanges', () => {
    const config = buildConfig({
      pinned: ['frontend/src/styling', 'frontend/src/styling/tailwind.css', 'backend/src/modules.ts'],
      ignored: ['shared/config/'],
    });

    it('groups paths under their most specific pinned or ignored entry, in the order they come', () => {
      const paths = [
        'shared/config/staging.ts',
        'frontend/src/styling/tailwind.css',
        'frontend/src/styling/gradients.css',
        'shared/config/default.ts',
        'frontend/src/styling/base.css',
      ];
      expect(groupProtectedUpstreamChanges(paths, config)).toEqual([
        { entry: 'shared/config', paths: ['shared/config/default.ts', 'shared/config/staging.ts'] },
        { entry: 'frontend/src/styling/tailwind.css', paths: ['frontend/src/styling/tailwind.css'] },
        {
          entry: 'frontend/src/styling',
          paths: ['frontend/src/styling/base.css', 'frontend/src/styling/gradients.css'],
        },
      ]);
    });

    it('lets a path no entry covers stand for itself', () => {
      expect(groupProtectedUpstreamChanges(['package.json', 'backend/src/modules.ts'], config)).toEqual([
        { entry: 'package.json', paths: ['package.json'] },
        { entry: 'backend/src/modules.ts', paths: ['backend/src/modules.ts'] },
      ]);
      expect(groupProtectedUpstreamChanges([], config)).toEqual([]);
    });
  });

  describe('validateOverrides', () => {
    let env: TestEnv;

    beforeEach(() => {
      env = createTestEnv();
      // Upstream has a ledger and a docs folder the fork keeps out, plus a folder the fork keeps
      makeCommit(env.upstreamPath, {
        files: { 'json/ledger.json': '{}\n', 'docs/guide.md': '# Guide\n', 'kept/file.ts': 'export {};\n' },
        message: 'feat: ledger and docs',
      });
      fetchUpstream(env.forkPath);
      makeCommit(env.forkPath, { files: { 'kept/file.ts': 'export {};\n' }, message: 'feat: kept' });
    });

    afterEach(() => {
      env.cleanup();
    });

    const ignored = ['json/ledger.json', 'docs/', 'kept', 'never/existed'];

    it('warns about an ignored entry only when the path is in neither the fork nor upstream', async () => {
      const warnings = await validateOverrides(buildConfig({ ignored }), env.forkPath, 'cella-upstream/main');
      expect(warnings.map((warning) => warning.message)).toEqual(['ignored entry not found: never/existed']);
    });

    it('warns once upstream no longer has the path either', async () => {
      deleteFileAndCommit(env.upstreamPath, 'json/ledger.json', 'chore: drop ledger');
      fetchUpstream(env.forkPath);

      const warnings = await validateOverrides(buildConfig({ ignored }), env.forkPath, 'cella-upstream/main');
      expect(warnings.map((warning) => warning.pattern)).toEqual(['json/ledger.json', 'never/existed']);
    });

    it('warns about every ignored entry missing from the fork while no upstream ref resolves', async () => {
      const missing = ['json/ledger.json', 'docs/', 'never/existed'];
      const unfetched = await validateOverrides(buildConfig({ ignored }), env.forkPath, 'cella-upstream/unfetched');
      expect(unfetched.map((warning) => warning.pattern)).toEqual(missing);

      const noRef = await validateOverrides(buildConfig({ ignored }), env.forkPath);
      expect(noRef.map((warning) => warning.pattern)).toEqual(missing);
    });

    it('keeps warning about pins missing from the fork and about globs', async () => {
      const config = buildConfig({ pinned: ['json/ledger.json', 'src/*.ts'], ignored: ['docs/*'] });
      const warnings = await validateOverrides(config, env.forkPath, 'cella-upstream/main');
      expect(warnings.map((warning) => warning.type)).toEqual(['pinned-not-found', 'pinned-glob', 'ignored-not-found']);
    });
  });
});
