/**
 * Unit tests for managed-file detection.
 *
 * Covers `isManagedFile` / `isConfigFile` recognizing the sync config at both its
 * current (`cella/cella.config.ts`) and legacy root (`cella.config.ts`) path, so the
 * one sync that moves the config into `cella/` does not spuriously conflict.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG_FILE, isConfigFile, isManagedFile, LEGACY_CONFIG_FILE } from '../src/utils/managed-files';

describe('isConfigFile', () => {
  it('matches the current config path', () => {
    expect(isConfigFile(CONFIG_FILE)).toBe(true);
    expect(isConfigFile('cella/cella.config.ts')).toBe(true);
  });

  it('matches the legacy root config path (pre-cella/ move)', () => {
    expect(isConfigFile(LEGACY_CONFIG_FILE)).toBe(true);
    expect(isConfigFile('cella.config.ts')).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(isConfigFile('cella/cella.manifest.json')).toBe(false);
    expect(isConfigFile('src/cella.config.ts')).toBe(false);
  });
});

describe('isManagedFile', () => {
  it('treats the config as managed at both current and legacy paths', () => {
    expect(isManagedFile('cella/cella.config.ts')).toBe(true);
    expect(isManagedFile('cella.config.ts')).toBe(true);
  });

  it('still treats package.json and the lockfile as managed', () => {
    expect(isManagedFile('package.json')).toBe(true);
    expect(isManagedFile('backend/package.json')).toBe(true);
    expect(isManagedFile('pnpm-lock.yaml')).toBe(true);
  });

  it('does not treat ordinary files as managed', () => {
    expect(isManagedFile('frontend/src/nav-config.tsx')).toBe(false);
  });
});
