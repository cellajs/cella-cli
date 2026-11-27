import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { formatHeader } from './header';

const plain = (text: string) => stripVTControlCharacters(text).split('\n');

describe('formatHeader', () => {
  it('opens on the package header, then the command with the environment as a badge, and names a stack not set up yet', () => {
    const lines = plain(formatHeader({ version: '0.47.1', environment: 'production', state: 'bootstrapped', host: 'www.acme.dev' }));
    expect(lines[0]).toMatch(/^⧈ cella cli · v\S+ +cellajs\.com$/);
    expect(lines.slice(2, 4)).toEqual(['', '$ pnpm cella infra    PRODUCTION   www.acme.dev · checkout 0.47.1']);
    expect(plain(formatHeader({ environment: 'staging', state: 'partial' }))[3]).toBe('$ pnpm cella infra    STAGING   setup not finished');
    expect(plain(formatHeader({ environment: 'staging', state: 'fresh' }))[3]).toMatch(/STAGING {3}new$/);
  });
});
