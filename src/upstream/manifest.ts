/**
 * Cella upgrade manifest: the committed record of the last upstream point the app upgraded to.
 * `upstream.commit` seeds the merge-base on a clone without `refs/cella/last-upgrade` (fresh clone,
 * CI), and the rest shows in each upgrade PR which upstream point the app moved to. The merge engine
 * stages it with every applied upgrade.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Committed manifest path, relative to the fork repo root. */
export const MANIFEST_FILE = 'cella/cella.manifest.json';

/** The last upstream sync point recorded in {@link MANIFEST_FILE}. */
export interface SyncManifest {
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
export function parseSyncManifest(raw: string): SyncManifest | null {
  try {
    const parsed = JSON.parse(raw) as SyncManifest;
    const commit = parsed?.upstream?.commit;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read and validate the manifest. Returns null when absent or malformed. */
export async function readSyncManifest(cwd: string): Promise<SyncManifest | null> {
  try {
    return parseSyncManifest(await readFile(join(cwd, MANIFEST_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Return the recorded upstream base commit SHA, or null.
 * Bootstrap seed for {@link ensureSyncBase} when no local `refs/cella/last-upgrade` exists.
 */
export async function readManifestBase(cwd: string): Promise<string | null> {
  const manifest = await readSyncManifest(cwd);
  return manifest ? manifest.upstream.commit.toLowerCase() : null;
}

/** Write the manifest as pretty JSON with a trailing newline. */
export async function writeSyncManifest(cwd: string, manifest: SyncManifest): Promise<void> {
  const manifestPath = join(cwd, MANIFEST_FILE);
  // Ensure the cella/ folder exists (a fresh fork may not have it yet on its first upgrade).
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
