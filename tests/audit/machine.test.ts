import { describe, expect, it } from 'vitest';
import type { Feeds } from '../../src/audit/feeds';
import { type LocalTools, planLocalTools } from '../../src/audit/machine';

const now = Date.parse('2026-10-24T14:00:00Z');
const ago = (hours: number) => now - hours * 60 * 60 * 1000;

describe('local tools', () => {
  it('points each tool at a release older than the release age that has every fix, in its major when one there does', () => {
    const tools = (pnpmVersion: string): LocalTools => ({
      node: { version: '26.12.0', installer: null },
      pnpm: { version: pnpmVersion, installer: 'volta' },
      gh: { version: '2.69.0', installer: 'brew' },
    });
    const feeds: Feeds = {
      node: [
        { version: '26.13.0', publishedAt: ago(1), security: true },
        { version: '26.12.1', publishedAt: ago(27), security: true },
      ],
      pnpm: [
        { version: 'created', publishedAt: ago(9000) },
        { version: '10.34.5', publishedAt: ago(48) },
        { version: '10.34.6', publishedAt: ago(2) },
        { version: '11.8.0', publishedAt: ago(3000) },
        { version: '11.28.6', publishedAt: ago(170) },
      ],
      pnpmAdvisories: [
        { vulnerable_versions: '<10.34.5', severity: 'high' },
        { vulnerable_versions: '<10.28.1', severity: 'moderate' },
        { vulnerable_versions: '>=11.0.0 <11.11.0', severity: 'high' },
      ],
      gh: null,
      ghAdvisories: ['low', 'high', 'low'],
      images: [],
    };
    const options = { releaseAgeMinutes: 1440, now };

    expect(planLocalTools(tools('10.12.3'), feeds, options)).toEqual([
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
    expect(planLocalTools(tools('9.15.0'), feeds, options)[1].fix).toBe('volta install pnpm@11.28.6');
  });
});
