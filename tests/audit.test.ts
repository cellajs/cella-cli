import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CACHE_FILE,
  CHANGELOG_PATHS,
  DEFAULT_BRANCHES,
  getReleasesUrl,
  getRepoUrl,
  isMajorVersionChange,
  loadCache,
  type NpmRegistryData,
} from '../src/utils/audit-utils';
import { hyperlink } from '../src/utils/display';

describe('audit-utils', () => {
  describe('isMajorVersionChange', () => {
    it('detects major version bumps', () => {
      expect(isMajorVersionChange('1.0.0', '2.0.0')).toBe(true);
      expect(isMajorVersionChange('0.9.0', '1.0.0')).toBe(true);
      expect(isMajorVersionChange('24.10.8', '25.0.8')).toBe(true);
    });

    it('does not flag minor or patch updates as major', () => {
      expect(isMajorVersionChange('1.0.0', '1.1.0')).toBe(false);
      expect(isMajorVersionChange('1.0.0', '1.0.1')).toBe(false);
      expect(isMajorVersionChange('0.208.0', '0.210.0')).toBe(false);
    });

    it('handles prerelease and dev versions', () => {
      expect(isMajorVersionChange('1.0.0-beta', '2.0.0')).toBe(true);
      expect(isMajorVersionChange('7.0.0-dev.20260129.1', '7.0.0-dev.20260115.1')).toBe(false);
    });

    it('returns false for invalid versions', () => {
      expect(isMajorVersionChange('', '1.0.0')).toBe(false);
      expect(isMajorVersionChange('1.0.0', '')).toBe(false);
    });
  });

  describe('getRepoUrl', () => {
    it('returns null for missing data', () => {
      expect(getRepoUrl(null)).toBe(null);
      expect(getRepoUrl({} as NpmRegistryData)).toBe(null);
    });

    it('normalizes various URL formats', () => {
      expect(getRepoUrl({ repository: { url: 'git+https://github.com/user/repo.git' } })).toBe(
        'https://github.com/user/repo',
      );
      expect(getRepoUrl({ repository: { url: 'git://github.com/user/repo.git' } })).toBe(
        'https://github.com/user/repo',
      );
      expect(getRepoUrl({ repository: { url: 'https://github.com/user/repo' } })).toBe('https://github.com/user/repo');
    });
  });

  describe('getReleasesUrl', () => {
    it('returns releases URL only for GitHub repos', () => {
      expect(getReleasesUrl('https://github.com/user/repo')).toBe('https://github.com/user/repo/releases');
      expect(getReleasesUrl('https://gitlab.com/user/repo')).toBe(null);
      expect(getReleasesUrl(null)).toBe(null);
    });
  });

  describe('hyperlink', () => {
    it('creates OSC 8 hyperlink format', () => {
      const result = hyperlink('click me', 'https://example.com');
      expect(result).toContain('\u001B]8;;https://example.com\u0007');
      expect(result).toContain('click me');
    });

    it('strips control characters from the URL', () => {
      const result = hyperlink('label', 'https://example.com/\x07evil');
      expect(result).toContain('https://example.com/evil');
    });

    it('falls back to the plain label without a URL', () => {
      expect(hyperlink('plain')).toBe('plain');
    });
  });

  describe('constants', () => {
    it('has expected changelog paths', () => {
      expect(CHANGELOG_PATHS).toContain('CHANGELOG.md');
      expect(CHANGELOG_PATHS).toContain('HISTORY.md');
    });

    it('has default branches', () => {
      expect(DEFAULT_BRANCHES).toContain('main');
      expect(DEFAULT_BRANCHES).toContain('master');
    });

    it('has correct cache file location', () => {
      expect(CACHE_FILE).toContain('.audit.cache.json');
      expect(CACHE_FILE).not.toContain(`${path.sep}src${path.sep}`);
    });
  });

  describe('loadCache', () => {
    it('returns empty object when cache file does not exist', () => {
      // loadCache handles missing file gracefully
      const cache = loadCache();
      expect(typeof cache).toBe('object');
    });
  });
});
