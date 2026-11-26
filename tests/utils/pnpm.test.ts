import { execFile } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { fetchPublishTimes } from '../../src/utils/pnpm';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('fetchPublishTimes', () => {
  it('refuses a package name that pnpm would read as an option', async () => {
    expect(await fetchPublishTimes('--registry=http://attacker.example', process.cwd())).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });
});
