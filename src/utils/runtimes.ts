/**
 * Runtime pins for the audit: the Node and pnpm versions the root package.json pins, and the image
 * tags of the Dockerfiles, checked against their release feeds. Reading, planning and rewriting
 * are pure; the fetches never throw, so a feed that does not answer only leaves its runtime out.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { editJsonText, fetchPublishTimes } from './audit-utils';
import { git } from './git';
import { compareVersionStrings, isPrerelease, parseComparableVersion, satisfiesComparators } from './versions';

/** An image tag in a Dockerfile `FROM` line. */
export interface ImagePin {
  file: string;
  /** Zero-based line of the `FROM`. */
  line: number;
  /** The image as written, e.g. `caddy` or `bitnami/redis`. */
  image: string;
  tag: string;
}

/** What the workspace pins: exact versions only, since a range already follows its line. */
export interface RuntimePins {
  node: string | null;
  pnpm: string | null;
  images: ImagePin[];
  /** Suffixes of `FROM node:${…}<suffix>` lines (`-alpine`): the images a Node bump needs to exist. */
  nodeImageSuffixes: string[];
}

/** A Node release from nodejs.org, with the time it was published. */
export interface NodeRelease {
  version: string;
  publishedAt: number;
  security: boolean;
}

/** An image tag on Docker Hub and when it was last pushed. */
export interface HubTag {
  name: string;
  pushedAt: number;
}

/** An npm advisory, reduced to its vulnerable range. */
interface BulkAdvisory {
  vulnerable_versions: string;
}

/** What the feeds answered; null where a feed did not answer. */
export interface RuntimeFeeds {
  node: NodeRelease[] | null;
  pnpm: { published: Record<string, string>; advisories: BulkAdvisory[] } | null;
  /** Per image pin, in the order of {@link RuntimePins.images}. */
  images: Array<{ pinned: HubTag | null; tags: HubTag[] } | null>;
}

/** How a pin moves, and what the audit shows about it. */
export interface RuntimeUpdate {
  name: string;
  current: string;
  target: string;
  /** Where it is pinned, relative to the workspace root. */
  file: string;
  /** A red dot for a security fix, a yellow dot for a tag that stopped getting pushes. */
  severity: 'high' | 'moderate' | null;
  note: string;
  releasesUrl: string;
  pin: { kind: 'node' } | { kind: 'pnpm' } | { kind: 'image'; line: number; ref: string; to: string };
}

const DAY = 24 * 60 * 60 * 1000;

/** A tag without a push for this long, while a newer line got one, gets no more fixes. */
const FROZEN_AFTER = 180 * DAY;
const RECENT_PUSH = 30 * DAY;

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const FROM_LINE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

/** `FROM node:${NODE_VERSION}-alpine`: the version comes from a build argument. */
const NODE_ARG_TAG = /^(?:docker\.io\/)?(?:library\/)?node:\$\{?\w+\}?([\w.-]*)$/;

/** A tag naming at least a minor (`2.8`, `2.8.4`), with an optional suffix (`-alpine`). */
const MINOR_TAG = /^(\d+(?:\.\d+){1,2})(-[\w.-]+)?$/;

const isDockerfile = (path: string): boolean => /(^|\.)Dockerfile$|^Dockerfile\./i.test(basename(path));

/** The image pins and Node build-argument suffixes in one Dockerfile. */
export function parseDockerfile(file: string, content: string): { images: ImagePin[]; nodeImageSuffixes: string[] } {
  const images: ImagePin[] = [];
  const nodeImageSuffixes: string[] = [];
  const stages = new Set<string>();

  content.split('\n').forEach((text, line) => {
    const match = text.match(FROM_LINE);
    if (!match) return;
    const [, ref, stage] = match;
    const fromStage = stages.has(ref.toLowerCase());
    if (stage) stages.add(stage.toLowerCase());
    if (fromStage || ref.includes('@')) return;

    const nodeArg = ref.match(NODE_ARG_TAG);
    if (nodeArg) {
      nodeImageSuffixes.push(nodeArg[1]);
      return;
    }
    if (ref.includes('$')) return;

    const slash = ref.lastIndexOf('/');
    const colon = ref.lastIndexOf(':');
    if (colon <= slash) return;
    let image = ref.slice(0, colon);
    const tag = ref.slice(colon + 1);
    const host = image.includes('/') ? image.split('/')[0] : '';
    if (host === 'docker.io') image = image.slice(host.length + 1).replace(/^library\//, '');
    else if (host.includes('.') || host.includes(':') || host === 'localhost') return;
    if (image === 'scratch') return;
    images.push({ file, line, image, tag });
  });

  return { images, nodeImageSuffixes };
}

/** The exact Node and pnpm pins of the root package.json, and the image tags of every tracked Dockerfile. */
export async function readRuntimePins(forkPath: string): Promise<RuntimePins> {
  let manifest: { engines?: { node?: string }; packageManager?: string } = {};
  try {
    manifest = JSON.parse(readFileSync(join(forkPath, 'package.json'), 'utf8'));
  } catch {
    // No root manifest: nothing pinned there.
  }
  const node = manifest.engines?.node?.trim() ?? '';
  const pnpm = manifest.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/)?.[1] ?? null;

  const tracked = (await git(['ls-files', '-z'], forkPath, { ignoreErrors: true })).split('\0').filter(isDockerfile);
  const images: ImagePin[] = [];
  const nodeImageSuffixes = new Set<string>();
  for (const file of tracked) {
    let content: string;
    try {
      content = readFileSync(join(forkPath, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDockerfile(file, content);
    images.push(...parsed.images);
    for (const suffix of parsed.nodeImageSuffixes) nodeImageSuffixes.add(suffix);
  }

  return {
    node: EXACT_VERSION.test(node) ? node : null,
    pnpm,
    images,
    nodeImageSuffixes: [...nodeImageSuffixes],
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const hubRepository = (image: string): string => (image.includes('/') ? image : `library/${image}`);

const hubTag = (entry: unknown): HubTag | null => {
  const { name, last_updated } = (entry ?? {}) as { name?: string; last_updated?: string };
  const pushedAt = Date.parse(last_updated ?? '');
  return name && !Number.isNaN(pushedAt) ? { name, pushedAt } : null;
};

/**
 * Node releases from nodejs.org. The index gives a release day only, so a release from the last
 * two days, where the day alone cannot settle the release age, gets its exact time from the
 * Last-Modified header of its checksum file (the end of its day when that does not answer).
 */
async function fetchNodeReleases(major: number, now: number): Promise<NodeRelease[] | null> {
  const index = await fetchJson('https://nodejs.org/dist/index.json');
  if (!Array.isArray(index)) return null;
  const releases = index
    .map((entry) => entry as { version?: string; date?: string; security?: boolean })
    .filter((entry) => entry.version && parseComparableVersion(entry.version)?.major === major)
    .map((entry) => ({
      version: String(entry.version).replace(/^v/, ''),
      publishedAt: Date.parse(entry.date ?? ''),
      security: entry.security === true,
    }))
    .filter((release) => !Number.isNaN(release.publishedAt));

  await Promise.all(
    releases
      .filter((release) => now - release.publishedAt < 2 * DAY)
      .map(async (release) => {
        try {
          const response = await fetch(`https://nodejs.org/dist/v${release.version}/SHASUMS256.txt`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(10_000),
          });
          const modified = Date.parse(response.headers.get('last-modified') ?? '');
          release.publishedAt = Number.isNaN(modified) ? release.publishedAt + DAY : modified;
        } catch {
          release.publishedAt += DAY;
        }
      }),
  );
  return releases;
}

async function fetchImageTags(pin: ImagePin): Promise<{ pinned: HubTag | null; tags: HubTag[] } | null> {
  const shape = pin.tag.match(MINOR_TAG);
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

/** Ask every feed the pins need, in parallel. Only pins whose tag names a minor reach Docker Hub. */
export async function fetchRuntimeFeeds(pins: RuntimePins, cwd: string, now: number): Promise<RuntimeFeeds> {
  const nodeMajor = pins.node ? parseComparableVersion(pins.node)?.major : undefined;
  const [node, published, advisories, images] = await Promise.all([
    nodeMajor === undefined ? null : fetchNodeReleases(nodeMajor, now),
    pins.pnpm ? fetchPublishTimes('pnpm', cwd) : null,
    pins.pnpm
      ? fetchJson('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pnpm: [pins.pnpm] }),
        })
      : null,
    Promise.all(pins.images.map(fetchImageTags)),
  ]);
  const pnpmAdvisories = (advisories as { pnpm?: BulkAdvisory[] } | null)?.pnpm;
  return {
    node,
    pnpm: published && advisories ? { published, advisories: pnpmAdvisories ?? [] } : null,
    images,
  };
}

const count = (n: number, noun: string, plural = `${noun}s`): string => `${n} ${n === 1 ? noun : plural}`;

const monthYear = (time: number): string =>
  new Date(time).toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toLowerCase();

/** The highest version above `pinned` in its major that is older than the release age. */
function newestAged(pinned: string, versions: Array<{ version: string; publishedAt: number }>, cutoff: number) {
  const major = parseComparableVersion(pinned)?.major;
  return versions
    .filter(
      (entry) =>
        !isPrerelease(entry.version) &&
        parseComparableVersion(entry.version)?.major === major &&
        compareVersionStrings(entry.version, pinned) > 0 &&
        entry.publishedAt <= cutoff,
    )
    .sort((a, b) => compareVersionStrings(b.version, a.version))[0];
}

/**
 * The pins that can move: a newer version in the same major (a newer minor tag for an image), never
 * younger than the release age. `unchecked` names each runtime whose feed did not answer.
 */
export function planRuntimeUpdates(
  pins: RuntimePins,
  feeds: RuntimeFeeds,
  options: { releaseAgeMinutes: number; now: number },
): { updates: RuntimeUpdate[]; unchecked: string[] } {
  const cutoff = options.now - options.releaseAgeMinutes * 60 * 1000;
  const updates: RuntimeUpdate[] = [];
  const unchecked: string[] = [];

  if (pins.node) {
    if (!feeds.node) unchecked.push('node');
    const target = feeds.node && newestAged(pins.node, feeds.node, cutoff);
    if (target) {
      const node = pins.node;
      const security = (feeds.node ?? []).some(
        (release) =>
          release.security &&
          compareVersionStrings(release.version, node) > 0 &&
          compareVersionStrings(release.version, target.version) <= 0,
      );
      updates.push({
        name: 'node',
        current: node,
        target: target.version,
        file: 'package.json',
        severity: security ? 'high' : null,
        note: security ? 'security release' : '',
        releasesUrl: `https://nodejs.org/en/blog/release/v${target.version}`,
        pin: { kind: 'node' },
      });
    }
  }

  if (pins.pnpm) {
    if (!feeds.pnpm) unchecked.push('pnpm');
    const published = Object.entries(feeds.pnpm?.published ?? {}).map(([version, time]) => ({
      version,
      publishedAt: Date.parse(time),
    }));
    const target = feeds.pnpm && newestAged(pins.pnpm, published, cutoff);
    if (target) {
      const pnpm = pins.pnpm;
      const fixed = (feeds.pnpm?.advisories ?? []).filter(
        (advisory) =>
          satisfiesComparators(pnpm, advisory.vulnerable_versions) &&
          !satisfiesComparators(target.version, advisory.vulnerable_versions),
      ).length;
      updates.push({
        name: 'pnpm',
        current: pnpm,
        target: target.version,
        file: 'package.json',
        severity: fixed > 0 ? 'high' : null,
        note: fixed > 0 ? count(fixed, 'advisory', 'advisories') : '',
        releasesUrl: `https://github.com/pnpm/pnpm/releases/tag/v${target.version}`,
        pin: { kind: 'pnpm' },
      });
    }
  }

  pins.images.forEach((pin, i) => {
    const shape = pin.tag.match(MINOR_TAG);
    if (!shape) return;
    const feed = feeds.images[i];
    if (!feed) {
      unchecked.push(pin.image);
      return;
    }
    const [, version, suffix = ''] = shape;
    const parts = version.split('.').length;
    const major = version.split('.')[0];
    const target = feed.tags
      .map((tag) => ({ tag, match: tag.name.match(MINOR_TAG) }))
      .filter(
        ({ match }) =>
          match &&
          (match[2] ?? '') === suffix &&
          match[1].split('.').length === parts &&
          match[1].split('.')[0] === major &&
          compareVersionStrings(match[1], version) > 0,
      )
      .sort((a, b) => compareVersionStrings(b.match?.[1] ?? '', a.match?.[1] ?? ''))[0];
    if (!target?.match) return;

    const frozen =
      !!feed.pinned &&
      options.now - feed.pinned.pushedAt > FROZEN_AFTER &&
      options.now - target.tag.pushedAt < RECENT_PUSH;
    const repository = hubRepository(pin.image);
    updates.push({
      name: pin.image,
      current: version,
      target: target.match[1],
      file: pin.file,
      severity: frozen ? 'moderate' : null,
      note: frozen && feed.pinned ? `tag frozen since ${monthYear(feed.pinned.pushedAt)}` : '',
      releasesUrl: repository.startsWith('library/')
        ? `https://hub.docker.com/_/${pin.image}/tags`
        : `https://hub.docker.com/r/${repository}/tags`,
      pin: { kind: 'image', line: pin.line, ref: `${pin.image}:${pin.tag}`, to: `${pin.image}:${target.tag.name}` },
    });
  });

  return { updates, unchecked };
}

/** The file content with the update's pin moved to its target. */
export function applyRuntimeUpdate(content: string, update: RuntimeUpdate): string {
  const { pin } = update;
  if (pin.kind === 'image') {
    const lines = content.split('\n');
    lines[pin.line] = lines[pin.line].replace(pin.ref, pin.to);
    return lines.join('\n');
  }
  return editJsonText(content, (json) => {
    if (pin.kind === 'node') (json.engines as Record<string, string>).node = update.target;
    // A `+sha` suffix names the old version's tarball, so it goes.
    else json.packageManager = `pnpm@${update.target}`;
  });
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

/** Where a pin lives, for the table: the file's directory, or the file itself at the root. */
export function pinLocation(file: string): string {
  const dir = dirname(file);
  return dir === '.' ? file : dir;
}
