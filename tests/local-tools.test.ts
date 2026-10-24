import { describe, expect, it } from 'vitest';
import { type LocalTools, planLocalTools } from '../src/utils/local-tools';

const NOW = Date.parse('2026-10-24T14:00:00Z');
const ago = (hours: number) => NOW - hours * 60 * 60 * 1000;
const iso = (hours: number) => new Date(ago(hours)).toISOString();

describe('local tools', () => {
  it('points each tool at a release older than the release age that has every fix, in its major when one there does', () => {
    const pnpm = (version: string): LocalTools['pnpm'] => ({
      version,
      installer: 'volta',
      published: {
        created: iso(9000),
        '10.34.5': iso(48),
        '10.34.6': iso(2),
        '11.8.0': iso(3000),
        '11.28.6': iso(170),
      },
      advisories: [
        { vulnerable_versions: '<10.34.5', severity: 'high' },
        { vulnerable_versions: '<10.28.1', severity: 'moderate' },
        { vulnerable_versions: '>=11.0.0 <11.11.0', severity: 'high' },
      ],
    });
    const tools = (pnpmVersion: string): LocalTools => ({
      node: {
        version: '26.12.0',
        installer: null,
        releases: [
          { version: '26.13.0', publishedAt: ago(1), security: true },
          { version: '26.12.1', publishedAt: ago(27), security: true },
        ],
      },
      pnpm: pnpm(pnpmVersion),
      gh: { version: '2.69.0', installer: 'brew', releases: null, advisories: ['low', 'high', 'low'] },
    });
    const options = { releaseAgeMinutes: 1440, now: NOW };

    expect(planLocalTools(tools('10.12.3'), options)).toEqual([
      { name: 'node', version: '26.12.0', severity: 'high', note: '1 security release', fix: 'update to 26.12.1' },
      {
        name: 'pnpm',
        version: '10.12.3',
        severity: 'high',
        note: '2 advisories, 1 high',
        fix: 'volta install pnpm@10.34.5',
      },
      {
        name: 'gh',
        version: '2.69.0',
        severity: 'high',
        note: '3 advisories, 1 high',
        fix: 'brew upgrade gh',
      },
    ]);
    // No 9.x release has every fix, so the newest one that does wins.
    expect(planLocalTools(tools('9.15.0'), options)[1].fix).toBe('volta install pnpm@11.28.6');
  });
});
