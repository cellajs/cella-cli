import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/types';
import { runAudit } from '../src/services/audit';
import { getReleasesUrl, getRepoUrl, runPnpmJson } from '../src/utils/audit-utils';
import { hyperlink } from '../src/utils/display';
import { getEnv } from '../src/utils/env';

const securityPass = vi.hoisted(() => vi.fn());
vi.mock('../src/services/audit-security', () => ({ runSecurityPass: securityPass }));

describe('audit-utils', () => {
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

  /** A `pnpm` on PATH that prints the engine warning unless only errors are logged, then FAKE_PNPM_STDOUT. */
  describe('pnpm JSON output', () => {
    let bin: string;

    beforeEach(() => {
      bin = mkdtempSync(join(tmpdir(), 'cella-fake-pnpm-'));
      const script = join(bin, 'pnpm');
      writeFileSync(
        script,
        [
          '#!/bin/sh',
          'case " $* " in *" --loglevel=error "*) ;; *) echo \'. | [WARN] Unsupported engine: wanted: {"node":"99.0.0"}\' ;; esac',
          'printf "%s" "$FAKE_PNPM_STDOUT"',
          '',
        ].join('\n'),
      );
      chmodSync(script, 0o755);
      vi.stubEnv('PATH', `${bin}${delimiter}${getEnv('PATH') ?? ''}`);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(bin, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('parses the JSON when pnpm would print a warning ahead of it', async () => {
      vi.stubEnv('FAKE_PNPM_STDOUT', '{"braces":{"current":"3.0.3"}}');
      expect(await runPnpmJson(['-r', 'outdated', '--json'], bin)).toEqual({ braces: { current: '3.0.3' } });
    });

    it('reports an unreadable outdated check, not an up-to-date workspace, and skips the security pass', async () => {
      vi.stubEnv('FAKE_PNPM_STDOUT', 'not json');
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      await runAudit({ forkPath: bin, list: true } as RuntimeConfig);
      const printed = info.mock.calls.flat().join('\n');
      expect(printed).toContain('pnpm outdated gave no answer');
      expect(printed).not.toContain('up to date');
      expect(securityPass).not.toHaveBeenCalled();
    });
  });
});
