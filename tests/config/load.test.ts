/**
 * `loadConfig` reads the 0.7 shape: `cella upgrade` installs the new CLI and runs its later stages with it while the
 * app's config, which an upgrade never merges, still has that shape.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/load';
import { write } from '../helpers/test-env';

const repos: string[] = [];

/** A repository holding only `cella/cella.config.ts` with this source. */
function repoWithConfig(source: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'cella-config-'));
  repos.push(repo);
  write(repo, { 'cella/cella.config.ts': source });
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('reads the 0.7 shape as the current one, with one warning naming the keys to change', async () => {
    const repo = repoWithConfig(`export default {
  settings: { upstreamUrl: 'x.git', releaseBase: 'develop', mergePackageJson: false, packageJsonKeys: ['scripts'] },
  overrides: { ignored: ['own'] },
  forks: [],
};
`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await loadConfig(repo)).toEqual({
      upstreamUrl: 'x.git',
      trunk: 'develop',
      packageJsonKeys: false,
      ignored: ['own'],
      forks: [],
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(
      'move settings.upstreamUrl, settings.packageJsonKeys, overrides.ignored to the top level, ' +
        'rename settings.releaseBase to trunk, drop settings.mergePackageJson',
    );
  });

  it('refuses a config that mixes the 0.7 shape with the current one', async () => {
    const repo = repoWithConfig(`export default { upstreamUrl: 'x.git', overrides: { pinned: ['a.ts'] } };\n`);
    await expect(loadConfig(repo)).rejects.toThrow(
      'mixes the 0.7 shape (settings, overrides) with top-level upstreamUrl',
    );
  });
});
