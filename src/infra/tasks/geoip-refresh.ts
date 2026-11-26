import { gunzipSync } from 'node:zlib';
import { printable } from '../../utils/terminal-text';
import { deployS3Key, makeS3Client } from '../lib/scaleway/s3-client';
import { storedBeforeKeyRotation } from '../lib/stack/control-store';
import { errorMessage } from '../lib/utils/errors';

export type GeoipKind = 'country' | 'asn';
export const GEOIP_KINDS: readonly GeoipKind[] = ['country', 'asn'];
const DEFAULT_PREFIX = 'geoip';

/** What the prefix holds: the backend never reads it, operators and the staleness gate do. */
export interface GeoipManifest {
  /** The DB-IP release published; per database below, since the fallback month can differ. */
  month: string;
  publishedAt: string;
  months: Record<GeoipKind, string>;
}

/**
 * Publishing the DB-IP Lite GeoIP databases (CC BY 4.0) to the `geoip/` prefix of the app's public bucket, where every
 * API process downloads them from at boot and daily (backend/src/lib/geoip.ts). Effects are injected like
 * reset-database, so unit tests assert the order and every guard; `main` supplies the live ones for the deploy, which runs it staleness-gated.
 */
export interface GeoipRefreshPlan {
  bucket: string;
  prefix: string;
  /** Target DB-IP release, `YYYY-MM`. The previous month is the fallback when this one is not published yet. */
  month: string;
  /** Publish even when the manifest already carries `month`. */
  force: boolean;
  /** Skip when the manifest is younger than this many days (the deploy pipeline's gate). */
  maxAgeDays?: number;
  /** The last key rotation: a manifest stored at or before it, or with no stored time, may be the lost deploy key's and is due. */
  keysRotatedAt?: Date;
  kinds: readonly GeoipKind[];

  // Injected effects
  fetchDatabase: (url: string) => Promise<{ status: number; body: Uint8Array | null }>;
  /** The manifest with the time Object Storage stored it; null when there is none. */
  readManifest: () => Promise<{ manifest: GeoipManifest; modified?: Date } | null>;
  putObject: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  now: () => Date;
  log: (message: string) => void;
}

export type GeoipRefreshResult =
  | { published: false; skipped: 'up-to-date' | 'fresh'; manifest: GeoipManifest }
  | { published: true; manifest: GeoipManifest };

export const databaseUrl = (kind: GeoipKind, month: string): string => `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`;

export const objectKey = (prefix: string, kind: GeoipKind): string => `${prefix}/dbip-${kind}-lite.mmdb.gz`;
export const manifestKey = (prefix: string): string => `${prefix}/manifest.json`;

/** `YYYY-MM` in UTC for a date, optionally shifted by whole months. */
export const monthOf = (date: Date, shiftMonths = 0): string => {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + shiftMonths, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
};

const MMDB_METADATA_MARKER = Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1');

/**
 * A downloaded archive is trusted only when it gunzips and the payload ends in the MMDB metadata section; anything
 * else (an HTML error page, a truncated stream) is refused before a single byte reaches the bucket.
 */
export const verifyMmdbArchive = (archive: Uint8Array): { ok: true } | { ok: false; reason: string } => {
  let payload: Buffer;
  try {
    payload = gunzipSync(archive);
  } catch (err) {
    return { ok: false, reason: `not a gzip stream (${errorMessage(err)})` };
  }
  // The marker sits at most 128 KiB from the end per the MMDB spec.
  const tail = payload.subarray(Math.max(0, payload.length - 128 * 1024));
  if (!tail.includes(MMDB_METADATA_MARKER)) return { ok: false, reason: 'no MMDB metadata section' };
  return { ok: true };
};

const ageDays = (iso: string, now: Date): number => (now.getTime() - new Date(iso).getTime()) / 86_400_000;

/**
 * Order the refresh: read the manifest and decide whether anything is due, download and verify every database,
 * then upload the databases and finally the manifest. A failed download or verification aborts before any upload,
 * so the bucket only ever moves from one complete set to the next.
 */
export async function sequenceGeoipRefresh(plan: GeoipRefreshPlan): Promise<GeoipRefreshResult> {
  const stored = await plan.readManifest();
  const existing = stored?.manifest;
  const stale = storedBeforeKeyRotation(stored?.modified, plan.keysRotatedAt);
  // A date in the future would keep the manifest younger than any age.
  const due = existing !== undefined && (stale || new Date(existing.publishedAt).getTime() > plan.now().getTime());
  if (due) plan.log('The GeoIP manifest was stored before the last key rotation, or is dated in the future: publishing again.');
  if (existing && !plan.force && !due) {
    if (existing.month === plan.month) {
      plan.log(`GeoIP data for ${plan.month} already published (${printable(existing.publishedAt)}); nothing to do.`);
      return { published: false, skipped: 'up-to-date', manifest: existing };
    }
    if (plan.maxAgeDays !== undefined && ageDays(existing.publishedAt, plan.now()) < plan.maxAgeDays) {
      plan.log(`GeoIP data published ${printable(existing.publishedAt)} is younger than ${plan.maxAgeDays} days; skipping.`);
      return { published: false, skipped: 'fresh', manifest: existing };
    }
  }

  const fallbackMonth = monthOf(new Date(`${plan.month}-01T00:00:00Z`), -1);
  const downloaded: Array<{ kind: GeoipKind; month: string; archive: Uint8Array }> = [];
  for (const kind of plan.kinds) {
    let month = plan.month;
    let response = await plan.fetchDatabase(databaseUrl(kind, month));
    if (response.status === 404) {
      plan.log(`DB-IP has not published ${kind} for ${month} yet; trying ${fallbackMonth}.`);
      month = fallbackMonth;
      response = await plan.fetchDatabase(databaseUrl(kind, month));
    }
    if (response.status !== 200 || !response.body) {
      throw new Error(`DB-IP ${kind} download failed with HTTP ${response.status} (${databaseUrl(kind, month)}).`);
    }
    const verified = verifyMmdbArchive(response.body);
    if (!verified.ok) throw new Error(`DB-IP ${kind} archive for ${month} rejected: ${verified.reason}.`);
    downloaded.push({ kind, month, archive: response.body });
    plan.log(`${kind} ${month}: ${(response.body.length / 1_048_576).toFixed(1)} MiB gzipped, verified.`);
  }

  const months = {} as GeoipManifest['months'];
  for (const { kind, month, archive } of downloaded) {
    const key = objectKey(plan.prefix, kind);
    await plan.putObject(key, archive, 'application/gzip');
    months[kind] = month;
    plan.log(`uploaded ${plan.bucket}/${key}`);
  }
  const manifest: GeoipManifest = {
    month: downloaded.some((file) => file.month === plan.month) ? plan.month : fallbackMonth,
    publishedAt: plan.now().toISOString(),
    months,
  };
  await plan.putObject(manifestKey(plan.prefix), Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
  plan.log(`uploaded ${plan.bucket}/${manifestKey(plan.prefix)} (month ${manifest.month})`);
  return { published: true, manifest };
}

/** Live effects: DB-IP over HTTPS, the bucket over the S3 API with the deploy key in the environment. */
export async function liveEffects(opts: { bucket: string; region: string; prefix: string }) {
  const { GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { accessKey, secretKey } = deployS3Key();
  const s3 = await makeS3Client(opts.region, accessKey, secretKey);
  return {
    fetchDatabase: async (url: string) => {
      const res = await fetch(url);
      return { status: res.status, body: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
    },
    readManifest: async (): Promise<{ manifest: GeoipManifest; modified?: Date } | null> => {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: opts.bucket, Key: manifestKey(opts.prefix) }));
        const text = await out.Body?.transformToString();
        if (!text) return null;
        try {
          return { manifest: JSON.parse(text) as GeoipManifest, modified: out.LastModified };
        } catch {
          // One that does not parse counts as missing: the files are published again.
          return null;
        }
      } catch (err) {
        if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null;
        throw err;
      }
    },
    putObject: async (key: string, body: Uint8Array, contentType: string) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: 'public, max-age=3600',
        }),
      );
    },
  };
}

/** What the deploy hands its GeoIP step. */
export interface GeoipRefreshStep {
  bucket: string;
  region: string;
  /** A month's data published fewer days ago than this is left as is. */
  maxAgeDays: number;
  /** The time of the last key rotation, absent before the first. */
  keysRotatedAt?: string;
}

/** The deploy's GeoIP step, this month's data under the default prefix. Needs SCW_ACCESS_KEY / SCW_SECRET_KEY (or AWS_*) with write access to the bucket. */
export async function main({ bucket, region, maxAgeDays, keysRotatedAt }: GeoipRefreshStep): Promise<void> {
  const prefix = DEFAULT_PREFIX;
  const effects = await liveEffects({ bucket, region, prefix });
  const result = await sequenceGeoipRefresh({
    bucket,
    prefix,
    month: monthOf(new Date()),
    force: false,
    maxAgeDays,
    keysRotatedAt: keysRotatedAt ? new Date(keysRotatedAt) : undefined,
    kinds: GEOIP_KINDS,
    ...effects,
    now: () => new Date(),
    log: (message) => process.stdout.write(`  ${message}\n`),
  });
  process.stdout.write(
    result.published
      ? `✓ GeoIP data ${result.manifest.month} published to ${bucket}/${prefix}\n`
      : `✓ GeoIP data left as is (${result.skipped}: ${printable(result.manifest.month)}, ${printable(result.manifest.publishedAt)})\n`,
  );
}
