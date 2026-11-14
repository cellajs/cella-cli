/**
 * Cella upgrade manifest: the committed record of the last upstream point the app upgraded to.
 * `upstream.commit` seeds the merge-base on a clone without `refs/cella/last-upgrade` (fresh clone,
 * CI), and the rest shows in each upgrade PR which upstream point the app moved to. The merge engine
 * stages it with every applied upgrade.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Committed manifest path, relative to the app root. */
export const manifestFile = 'cella/cella.manifest.json';

/** The upgrade point recorded in {@link manifestFile}. */
export interface UpgradeManifest {
  upstream: {
    /** GitHub slug of the upstream repo, e.g. 'cellajs/cella'. */
    repo?: string;
    /** Tracking mode at upgrade time. */
    track?: 'release' | 'branch';
    /** Integrated upstream commit SHA: the merge-base bootstrap seed. */
    commit: string;
    /** Release tag when tracking releases, else null. */
    release?: string | null;
    /** Human-readable link to the commit or release on GitHub. */
    url?: string;
    /** UTC timestamp of the upgrade (ISO 8601). */
    upgradedAt?: string;
  };
}

/** Parse and validate raw manifest JSON. Returns null when malformed or missing a 40-hex upstream commit. */
export function parseManifest(raw: string): UpgradeManifest | null {
  try {
    const parsed = JSON.parse(raw) as UpgradeManifest;
    const commit = parsed?.upstream?.commit;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read and validate the manifest. Returns null when absent or malformed. */
export async function readManifest(cwd: string): Promise<UpgradeManifest | null> {
  try {
    return parseManifest(await readFile(join(cwd, manifestFile), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The upgrade point the working-tree manifest records, or null.
 * Bootstrap seed for {@link ensureUpgradePoint} when no local `refs/cella/last-upgrade` exists.
 */
export async function readUpgradePoint(cwd: string): Promise<string | null> {
  const manifest = await readManifest(cwd);
  return manifest ? manifest.upstream.commit.toLowerCase() : null;
}

/** Write the manifest as pretty JSON with a trailing newline. */
export async function writeManifest(cwd: string, manifest: UpgradeManifest): Promise<void> {
  const manifestPath = join(cwd, manifestFile);
  // Ensure the cella/ folder exists (a fresh app may not have it yet on its first upgrade).
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
