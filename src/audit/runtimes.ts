import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import semver from 'semver';
import { plural } from '../utils/display';
import { git } from '../utils/git';
import {
  type BulkAdvisory,
  type Feeds,
  hubRepository,
  type ImageTags,
  minorTag,
  type NodeRelease,
  type Release,
} from './feeds';

/** An image tag in a Dockerfile `FROM` line. */
interface ImagePin {
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
  pin: { type: 'node' } | { type: 'pnpm' } | { type: 'image'; line: number; ref: string; to: string };
}

const day = 24 * 60 * 60 * 1000;

/** A tag without a push for this long, while a newer line got one, gets no more fixes. */
const frozenAfter = 180 * day;
const recentPush = 30 * day;

const exactVersion = /^\d+\.\d+\.\d+$/;

const fromLine = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

/** `FROM node:${NODE_VERSION}-alpine`: the version comes from a build argument. */
const nodeArgTag = /^(?:docker\.io\/)?(?:library\/)?node:\$\{?\w+\}?([\w.-]*)$/;

const isDockerfile = (path: string): boolean => /(^|\.)Dockerfile$|^Dockerfile\./i.test(basename(path));

/** The image pins and Node build-argument suffixes in one Dockerfile. */
export function parseDockerfile(file: string, content: string): { images: ImagePin[]; nodeImageSuffixes: string[] } {
  const images: ImagePin[] = [];
  const nodeImageSuffixes: string[] = [];
  const stages = new Set<string>();

  content.split('\n').forEach((text, line) => {
    const match = text.match(fromLine);
    if (!match) return;
    const [, ref, stage] = match;
    const fromStage = stages.has(ref.toLowerCase());
    if (stage) stages.add(stage.toLowerCase());
    if (fromStage || ref.includes('@')) return;

    const nodeArg = ref.match(nodeArgTag);
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
export async function readRuntimePins(repoRoot: string): Promise<RuntimePins> {
  let manifest: { engines?: { node?: string }; packageManager?: string } = {};
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    // No root manifest: nothing pinned there.
  }
  const node = manifest.engines?.node?.trim() ?? '';
  const pnpm = manifest.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/)?.[1] ?? null;

  const tracked = (await git(['ls-files', '-z'], repoRoot, { ignoreErrors: true })).split('\0').filter(isDockerfile);
  const images: ImagePin[] = [];
  const nodeImageSuffixes = new Set<string>();
  for (const file of tracked) {
    let content: string;
    try {
      content = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDockerfile(file, content);
    images.push(...parsed.images);
    for (const suffix of parsed.nodeImageSuffixes) nodeImageSuffixes.add(suffix);
  }

  return {
    node: exactVersion.test(node) ? node : null,
    pnpm,
    images,
    nodeImageSuffixes: [...nodeImageSuffixes],
  };
}

const monthYear = (time: number): string =>
  new Date(time).toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toLowerCase();

/** The highest stable version above `pinned` in its major that is older than the release age. */
export function newestAged(pinned: string, releases: Release[], cutoff: number): string | undefined {
  const aged = releases.filter((release) => release.publishedAt <= cutoff).map((release) => release.version);
  return semver.maxSatisfying(aged, `>${pinned} <${semver.major(pinned) + 1}`) ?? undefined;
}

function nodeUpdate(node: string, releases: NodeRelease[], cutoff: number): RuntimeUpdate | null {
  const target = newestAged(node, releases, cutoff);
  if (!target) return null;
  const security = releases.some(
    (release) => release.security && semver.satisfies(release.version, `>${node} <=${target}`),
  );
  return {
    name: 'node',
    current: node,
    target,
    file: 'package.json',
    severity: security ? 'high' : null,
    note: security ? 'security release' : '',
    releasesUrl: `https://nodejs.org/en/blog/release/v${target}`,
    pin: { type: 'node' },
  };
}

function pnpmUpdate(
  pnpm: string,
  releases: Release[],
  advisories: BulkAdvisory[],
  cutoff: number,
): RuntimeUpdate | null {
  const target = newestAged(pnpm, releases, cutoff);
  if (!target) return null;
  const fixed = advisories.filter(
    ({ vulnerable_versions: range }) => semver.satisfies(pnpm, range) && !semver.satisfies(target, range),
  ).length;
  return {
    name: 'pnpm',
    current: pnpm,
    target,
    file: 'package.json',
    severity: fixed > 0 ? 'high' : null,
    note: fixed > 0 ? plural(fixed, 'advisory', 'advisories') : '',
    releasesUrl: `https://github.com/pnpm/pnpm/releases/tag/v${target}`,
    pin: { type: 'pnpm' },
  };
}

/** A newer minor tag in the pin's line pushed before `cutoff`: the same major and suffix, as many version parts. */
function imageUpdate(pin: ImagePin, feed: ImageTags | null, now: number, cutoff: number): RuntimeUpdate | null {
  const [, version, suffix = ''] = pin.tag.match(minorTag) ?? [];
  if (!version || !feed) return null;
  // A tag naming a minor reads as a version: `2.8` is 2.8.0.
  const pinned = semver.coerce(version)!;
  const newer = feed.tags.flatMap((tag) => {
    const [, tagVersion, tagSuffix = ''] = tag.name.match(minorTag) ?? [];
    if (!tagVersion || tagSuffix !== suffix || tagVersion.split('.').length !== version.split('.').length) return [];
    if (tag.pushedAt > cutoff) return [];
    const parsed = semver.coerce(tagVersion)!;
    return parsed.major === pinned.major && semver.gt(parsed, pinned) ? [{ tag, version: tagVersion, parsed }] : [];
  });
  const target = newer.sort((a, b) => semver.rcompare(a.parsed, b.parsed))[0];
  if (!target) return null;

  const frozen = !!feed.pinned && now - feed.pinned.pushedAt > frozenAfter && now - target.tag.pushedAt < recentPush;
  const repository = hubRepository(pin.image);
  return {
    name: pin.image,
    current: version,
    target: target.version,
    file: pin.file,
    severity: frozen ? 'moderate' : null,
    note: frozen && feed.pinned ? `tag frozen since ${monthYear(feed.pinned.pushedAt)}` : '',
    releasesUrl: repository.startsWith('library/')
      ? `https://hub.docker.com/_/${pin.image}/tags`
      : `https://hub.docker.com/r/${repository}/tags`,
    pin: { type: 'image', line: pin.line, ref: `${pin.image}:${pin.tag}`, to: `${pin.image}:${target.tag.name}` },
  };
}

/**
 * The pins that can move: a newer version in the same major (a newer minor tag for an image), never
 * younger than the release age. `unchecked` names each runtime whose feed did not answer.
 */
export function planRuntimeUpdates(
  pins: RuntimePins,
  feeds: Feeds,
  options: { releaseAgeMinutes: number; now: number },
): { updates: RuntimeUpdate[]; unchecked: string[] } {
  const cutoff = options.now - options.releaseAgeMinutes * 60 * 1000;
  const { node, pnpm, pnpmAdvisories, images } = feeds;
  const updates = [
    pins.node && node ? nodeUpdate(pins.node, node, cutoff) : null,
    pins.pnpm && pnpm && pnpmAdvisories ? pnpmUpdate(pins.pnpm, pnpm, pnpmAdvisories, cutoff) : null,
    ...pins.images.map((pin, i) => imageUpdate(pin, images[i], options.now, cutoff)),
  ];
  const unchecked = [
    ...(pins.node && !node ? ['node'] : []),
    ...(pins.pnpm && !(pnpm && pnpmAdvisories) ? ['pnpm'] : []),
    ...pins.images.flatMap((pin, i) => (minorTag.test(pin.tag) && !images[i] ? [pin.image] : [])),
  ];
  return { updates: updates.filter((update) => update !== null), unchecked };
}

/**
 * JSON text after `change` ran on its parsed value, written back with the file's own indent and
 * final newline, the way pnpm writes a manifest.
 */
export function editJsonText(content: string, change: (json: Record<string, unknown>) => void): string {
  const json = JSON.parse(content) as Record<string, unknown>;
  change(json);
  const indent = content.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
  return `${JSON.stringify(json, null, indent)}${content.endsWith('\n') ? '\n' : ''}`;
}

/** The file content with the update's pin moved to its target. */
export function applyRuntimeUpdate(content: string, update: RuntimeUpdate): string {
  const { pin } = update;
  if (pin.type === 'image') {
    const lines = content.split('\n');
    lines[pin.line] = lines[pin.line].replace(pin.ref, pin.to);
    return lines.join('\n');
  }
  return editJsonText(content, (json) => {
    if (pin.type === 'node') (json.engines as Record<string, string>).node = update.target;
    // A `+sha` suffix names the old version's tarball, so it goes.
    else json.packageManager = `pnpm@${update.target}`;
  });
}

/** Where a pin lives, for the table: the file's directory, or the file itself at the root. */
export function pinLocation(file: string): string {
  const dir = dirname(file);
  return dir === '.' ? file : dir;
}
