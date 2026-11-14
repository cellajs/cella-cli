/**
 * The release and advisory feeds the audit checks the runtime pins and this machine's tools
 * against. Each feed is asked once per run, for every version that needs it. A fetch never throws:
 * a feed that does not answer is null, which leaves only its runtime or tool unchecked.
 */

import semver from 'semver';
import { fetchPublishTimes, severities, type VulnerabilitySeverity } from '../utils/pnpm';

const day = 24 * 60 * 60 * 1000;

/** A tag naming at least a minor (`2.8`, `2.8.4`), with an optional suffix (`-alpine`). */
export const minorTag = /^(\d+(?:\.\d+){1,2})(-[\w.-]+)?$/;

/** A published version and when it was published. */
export interface Release {
  version: string;
  publishedAt: number;
}

/** A Node release from nodejs.org. */
export interface NodeRelease extends Release {
  security: boolean;
}

/** An image tag on Docker Hub and when it was last pushed. */
export interface HubTag {
  name: string;
  pushedAt: number;
}

/** The pinned tag of an image and the tags of its line, newest push first. */
export interface ImageTags {
  pinned: HubTag | null;
  tags: HubTag[];
}

/** An npm advisory, reduced to its vulnerable range and severity. */
export interface BulkAdvisory {
  vulnerable_versions: string;
  severity: VulnerabilitySeverity;
}

/** What to ask the feeds about: the versions the workspace pins and this machine runs. */
export interface FeedRequest {
  node: string[];
  pnpm: string[];
  images: Array<{ image: string; tag: string }>;
  gh: string | null;
}

/** What the feeds answered; null where a feed was not asked or did not answer. */
export interface Feeds {
  /** The releases in the majors of the requested Node versions. */
  node: NodeRelease[] | null;
  /** Every version the registry lists, with keys such as `created` among them. */
  pnpm: Release[] | null;
  /** The advisories against any requested pnpm version. */
  pnpmAdvisories: BulkAdvisory[] | null;
  /** Per requested image, in its order. */
  images: Array<ImageTags | null>;
  gh: Release[] | null;
  /** The severity of each advisory OSV lists against the requested gh version. */
  ghAdvisories: VulnerabilitySeverity[] | null;
}

/** The parsed JSON answer of a URL; null for an error status, a timeout or unparsable output. */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** `caddy` lives at `library/caddy` on Docker Hub; a namespaced image as written. */
export const hubRepository = (image: string): string => (image.includes('/') ? image : `library/${image}`);

const hubTag = (entry: unknown): HubTag | null => {
  const { name, last_updated } = (entry ?? {}) as { name?: string; last_updated?: string };
  const pushedAt = Date.parse(last_updated ?? '');
  return name && !Number.isNaN(pushedAt) ? { name, pushedAt } : null;
};

/**
 * Node releases from nodejs.org in the majors of `versions`. The index gives a release day only,
 * so a release from the last two days, where the day alone cannot settle the release age, gets its
 * exact time from the Last-Modified header of its checksum file (the end of its day when that does
 * not answer).
 */
async function fetchNodeReleases(versions: string[], now: number): Promise<NodeRelease[] | null> {
  const index = await fetchJson('https://nodejs.org/dist/index.json');
  if (!Array.isArray(index)) return null;
  const majors = new Set(versions.map((version) => semver.major(version)));
  const releases = index
    .map((entry) => entry as { version?: string; date?: string; security?: boolean })
    .flatMap((entry) => {
      const version = semver.valid(entry.version ?? '');
      const publishedAt = Date.parse(entry.date ?? '');
      if (!version || !majors.has(semver.major(version)) || Number.isNaN(publishedAt)) return [];
      return [{ version, publishedAt, security: entry.security === true }];
    });

  await Promise.all(
    releases
      .filter((release) => now - release.publishedAt < 2 * day)
      .map(async (release) => {
        try {
          const response = await fetch(`https://nodejs.org/dist/v${release.version}/SHASUMS256.txt`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(10_000),
          });
          const modified = Date.parse(response.headers.get('last-modified') ?? '');
          release.publishedAt = Number.isNaN(modified) ? release.publishedAt + day : modified;
        } catch {
          release.publishedAt += day;
        }
      }),
  );
  return releases;
}

/** The Docker Hub tags of a pin's line; null for a tag that names no minor, or when Docker Hub does not answer. */
async function fetchImageTags(pin: { image: string; tag: string }): Promise<ImageTags | null> {
  const shape = pin.tag.match(minorTag);
  if (!shape) return null;
  const base = `https://hub.docker.com/v2/repositories/${hubRepository(pin.image)}/tags`;
  const filter = shape[2] ?? `${shape[1].split('.')[0]}.`;
  const [list, pinned] = await Promise.all([
    fetchJson(`${base}?page_size=100&ordering=last_updated&name=${encodeURIComponent(filter)}`),
    fetchJson(`${base}/${encodeURIComponent(pin.tag)}`),
  ]);
  const results = (list as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return null;
  return { pinned: hubTag(pinned), tags: results.flatMap((entry) => hubTag(entry) ?? []) };
}

/** The npm advisories against any of the pnpm versions. */
async function fetchPnpmAdvisories(versions: string[]): Promise<BulkAdvisory[] | null> {
  const answer = await fetchJson('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pnpm: versions }),
  });
  return answer ? ((answer as { pnpm?: BulkAdvisory[] }).pnpm ?? []) : null;
}

async function fetchGhReleases(): Promise<Release[] | null> {
  const list = await fetchJson('https://api.github.com/repos/cli/cli/releases?per_page=30');
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry) => {
    const { tag_name, published_at } = entry as { tag_name?: string; published_at?: string };
    const publishedAt = Date.parse(published_at ?? '');
    return tag_name && !Number.isNaN(publishedAt) ? [{ version: tag_name.replace(/^v/, ''), publishedAt }] : [];
  });
}

/**
 * The severity of each advisory OSV lists against a Go module version. OSV lists an advisory
 * under its GHSA id and its GO id, and only the GHSA entry carries a severity; one without a GHSA
 * entry counts as moderate.
 */
async function fetchOsvSeverities(module: string, version: string): Promise<VulnerabilitySeverity[] | null> {
  const answer = await fetchJson('https://api.osv.dev/v1/query', {
    method: 'POST',
    body: JSON.stringify({ package: { name: module, ecosystem: 'Go' }, version }),
  });
  if (!answer) return null;
  type OsvVuln = { id: string; aliases?: string[]; database_specific?: { severity?: string } };
  const byGhsa = new Map<string, VulnerabilitySeverity>();
  for (const vuln of (answer as { vulns?: OsvVuln[] }).vulns ?? []) {
    const id = [vuln.id, ...(vuln.aliases ?? [])].find((alias) => alias.startsWith('GHSA-')) ?? vuln.id;
    const severity = severities.find((level) => level === vuln.database_specific?.severity?.toLowerCase());
    if (severity || !byGhsa.has(id)) byGhsa.set(id, severity ?? 'moderate');
  }
  return [...byGhsa.values()];
}

/** Ask every feed the request needs, in parallel. */
export async function fetchFeeds(request: FeedRequest, cwd: string, now: number): Promise<Feeds> {
  const pnpm = request.pnpm.length > 0;
  const [node, pnpmTimes, pnpmAdvisories, images, gh, ghAdvisories] = await Promise.all([
    request.node.length > 0 ? fetchNodeReleases(request.node, now) : null,
    pnpm ? fetchPublishTimes('pnpm', cwd) : null,
    pnpm ? fetchPnpmAdvisories(request.pnpm) : null,
    Promise.all(request.images.map(fetchImageTags)),
    request.gh ? fetchGhReleases() : null,
    request.gh ? fetchOsvSeverities('github.com/cli/cli/v2', request.gh) : null,
  ]);
  return {
    node,
    pnpm: pnpmTimes && Object.entries(pnpmTimes).map(([version, time]) => ({ version, publishedAt: Date.parse(time) })),
    pnpmAdvisories,
    images,
    gh,
    ghAdvisories,
  };
}

/** The `node:<version><suffix>` images a Node bump would build from that Docker Hub does not have (yet). */
export async function missingNodeImages(version: string, suffixes: string[]): Promise<string[]> {
  const missing = await Promise.all(
    suffixes.map(async (suffix) => {
      const tag = `${version}${suffix}`;
      const found = await fetchJson(`https://hub.docker.com/v2/repositories/library/node/tags/${tag}`);
      return found ? [] : [`node:${tag}`];
    }),
  );
  return missing.flat();
}
