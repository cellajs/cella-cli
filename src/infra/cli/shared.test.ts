import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failWithHint } from '../lib/utils/cli-output';
import { autoAcceptDefaults, stackNameFor } from './shared';

const savedArgv = process.argv;

beforeEach(() => {
  process.argv = ['node', 'infra-cli.ts'];
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  process.argv = savedArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('autoAcceptDefaults', () => {
  it('is false in a plain interactive run', () => {
    expect(autoAcceptDefaults()).toBe(false);
  });

  it('is true with the --defaults flag', () => {
    process.argv = ['node', 'infra-cli.ts', '--defaults'];
    expect(autoAcceptDefaults()).toBe(true);
  });

  it('must not let the environment answer for the operator: INFRA_NON_INTERACTIVE no longer exists', () => {
    vi.stubEnv('INFRA_NON_INTERACTIVE', '1');
    expect(autoAcceptDefaults()).toBe(false);
  });
});

describe('failWithHint', () => {
  // deploy.ts passes an ExitCodeError's code through it, and main-job.ts reads 2 back as blocked.
  it('exits with the given code', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    expect(() => failWithHint('boom', { command: 'pnpm cella infra', description: 'why it broke' }, 3)).toThrow('exit:3');
    expect(exit).toHaveBeenCalledWith(3);
  });
});

describe('stackNameFor', () => {
  it('derives the DIY-backend stack name from the mode', () => {
    expect(stackNameFor({ environment: 'production' })).toBe('organization/infra/production');
  });
});
