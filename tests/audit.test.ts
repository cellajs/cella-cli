import { describe, expect, it } from 'vitest';
import { getReleasesUrl, getRepoUrl, isMajorVersionChange } from '../src/utils/audit-utils';
import { hyperlink } from '../src/utils/display';

describe('audit-utils', () => {
  it('isMajorVersionChange flags a major bump only, prereleases included, and false for invalid input', () => {
    expect(isMajorVersionChange('1.0.0', '2.0.0')).toBe(true);
    expect(isMajorVersionChange('0.9.0', '1.0.0')).toBe(true);
    expect(isMajorVersionChange('24.10.8', '25.0.8')).toBe(true);
    expect(isMajorVersionChange('1.0.0', '1.1.0')).toBe(false);
    expect(isMajorVersionChange('1.0.0', '1.0.1')).toBe(false);
    expect(isMajorVersionChange('0.208.0', '0.210.0')).toBe(false);
    expect(isMajorVersionChange('1.0.0-beta', '2.0.0')).toBe(true);
    expect(isMajorVersionChange('7.0.0-dev.20260129.1', '7.0.0-dev.20260115.1')).toBe(false);
    expect(isMajorVersionChange('', '1.0.0')).toBe(false);
    expect(isMajorVersionChange('1.0.0', '')).toBe(false);
  });

  describe('getRepoUrl', () => {
    it('returns null for a missing URL', () => {
      expect(getRepoUrl(undefined)).toBe(null);
      expect(getRepoUrl('')).toBe(null);
    });

    it('normalizes various URL formats', () => {
      expect(getRepoUrl('git+https://github.com/user/repo.git')).toBe('https://github.com/user/repo');
      expect(getRepoUrl('git://github.com/user/repo.git')).toBe('https://github.com/user/repo');
      expect(getRepoUrl('https://github.com/user/repo')).toBe('https://github.com/user/repo');
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
});
