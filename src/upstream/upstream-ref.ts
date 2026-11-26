import { defaultUpstreamRemote, resolveUpstream } from '../config/load';
import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { printStep, spinnerText, warningMark } from '../utils/display';
import { ensureRemote, fetchRemote, git, revParse } from '../utils/git';

/** The upstream ref a run merges from, and its release tag when it is a release. */
export interface UpstreamRef {
  ref: string;
  releaseTag?: string;
}

/** The run's tracking mode: a per-run `--track` over the configured `upstreamTrack`. */
function runTrack(config: RuntimeConfig): 'release' | 'branch' {
  return config.track ?? resolveUpstream(config).track;
}

/**
 * Point the upstream remote at the configured URL and fetch it, with upstream's release tags when
 * the run resolves a release or a `--ref`.
 */
export async function fetchUpstream(config: RuntimeConfig): Promise<void> {
  const { repoRoot } = config;
  spinnerText(`fetching upstream (${defaultUpstreamRemote})...`);
  await ensureRemote(repoRoot, defaultUpstreamRemote, config.upstreamUrl);
  await fetchRemote(repoRoot, defaultUpstreamRemote);
  if (config.ref || runTrack(config) === 'release') await fetchUpstreamTags(repoRoot, defaultUpstreamRemote);
}

/**
 * The concrete ref to merge from, after the fetch. A per-run `--ref` pins it and wins over `--track`;
 * otherwise release tracking (the default) takes the latest published release tag and branch
 * tracking the upstream branch tip.
 */
export async function resolveUpstreamRef(config: RuntimeConfig): Promise<UpstreamRef> {
  const { branchRef } = resolveUpstream(config);
  if (config.ref) return resolvePinnedRef(config, branchRef, config.ref);
  if (runTrack(config) === 'branch') return { ref: branchRef };

  const latest = await resolveLatestReleaseTag(config.repoRoot, defaultUpstreamRemote, branchRef);
  if (!latest) {
    throw new Error(
      `no upstream release tags found on ${branchRef}. Set upstreamTrack: 'branch' to follow ${branchRef}, ` +
        `or check that ${config.upstreamUrl} publishes release tags.`,
    );
  }
  return { ref: latest.ref, releaseTag: latest.tag };
}

/**
 * Resolve a `--ref` to the upstream commit this run upgrades to: an upstream branch name, a release
 * tag or a sha (see `resolveUpstreamCommit`). Refuses a ref that does not resolve, or one upstream
 * never published on its branch or in a release (an app commit, an upstream feature branch). A
 * release tag upgrades as that release; anything else as its commit sha, recorded like branch tracking.
 */
async function resolvePinnedRef(config: RuntimeConfig, branchRef: string, ref: string): Promise<UpstreamRef> {
  const { repoRoot } = config;
  const resolved = await resolveUpstreamCommit(repoRoot, defaultUpstreamRemote, ref);
  if (!resolved) {
    throw new Error(
      `--ref '${ref}' does not resolve to a commit. Pass a commit sha, a release tag or a branch on ` +
        `${config.upstreamUrl}.`,
    );
  }
  if (!(await isPublishedUpstream(repoRoot, defaultUpstreamRemote, branchRef, resolved.sha))) {
    throw new Error(
      `--ref '${ref}' (${resolved.sha.slice(0, 7)}) is not on ${branchRef} or in an upstream release. ` +
        'Upgrade only to commits upstream has published there.',
    );
  }
  return resolved.release ? { ref: resolved.release.ref, releaseTag: resolved.release.tag } : { ref: resolved.sha };
}

/**
 * Fetch upstream tags into a remote-scoped namespace (`refs/<remoteName>/tags/*`),
 * never the local `refs/tags/*`. This keeps cella's release tags from
 * colliding with the app's own release tags (apps run their own release-please).
 * `--no-tags` prevents git from also writing them into `refs/tags/*`.
 */
export async function fetchUpstreamTags(cwd: string, remoteName: string): Promise<void> {
  await git(['fetch', remoteName, '--no-tags', `+refs/tags/*:refs/${remoteName}/tags/*`], cwd);
}

/**
 * A template release tag is a version, with or without the `v` prefix (`0.18.1`, `v0.5.0`).
 * Component tags (`create-cella-0.2.3`) and other namespaces (`archive/pre-release`) start with a name.
 */
const releaseTagPattern = /^v?\d[\w.+-]*$/;

/**
 * Resolve the latest upstream release: the highest version tag in the remote-scoped tag namespace whose commit the
 * upstream branch (`branchRef`) contains. A higher tag off the branch is named in a warning and never picked. Returns
 * the short tag name and its full ref, or null when the branch holds no release.
 */
async function resolveLatestReleaseTag(
  cwd: string,
  remoteName: string,
  branchRef: string,
): Promise<{ tag: string; ref: string } | null> {
  const prefix = `refs/${remoteName}/tags/`;
  const highest = async (...filter: string[]) => {
    const output = await git(
      ['for-each-ref', '--sort=-version:refname', '--format=%(refname)', ...filter, prefix],
      cwd,
    );
    return output
      .split('\n')
      .map((line) => line.trim().slice(prefix.length))
      .find((tag) => releaseTagPattern.test(tag));
  };
  const [tag, anywhere] = await Promise.all([highest(`--merged=refs/remotes/${branchRef}`), highest()]);
  if (anywhere && anywhere !== tag) {
    printStep('release', pc.yellow(`skipped ${anywhere}: its commit is not on ${branchRef}`), warningMark);
  }
  return tag ? { tag, ref: `${prefix}${tag}` } : null;
}

/**
 * Resolve a ref named for upstream (`--ref`) to a commit: a branch on the upstream remote, then a
 * tag from the remote-scoped tag namespace, then the ref as given (a sha). Upstream names come
 * first, so `main` means upstream's main and `1.0.0` upstream's release, never the app's own.
 * Revision suffixes work too (`main~2`). Returns the commit sha, plus the release tag when the
 * ref is a release tag name itself (`1.2.3`, not `1.2.3~1`); null when nothing resolves.
 */
export async function resolveUpstreamCommit(
  cwd: string,
  remoteName: string,
  ref: string,
): Promise<{ sha: string; release?: { tag: string; ref: string } } | null> {
  if (ref.startsWith('-')) return null;
  const tagRef = `refs/${remoteName}/tags/${ref}`;
  for (const candidate of [`refs/remotes/${remoteName}/${ref}`, tagRef, ref]) {
    const sha = await revParse(cwd, `${candidate}^{commit}`);
    if (!sha) continue;
    const release = candidate === tagRef && releaseTagPattern.test(ref) ? { tag: ref, ref: tagRef } : undefined;
    return { sha, release };
  }
  return null;
}

/**
 * Whether upstream published `sha`: reachable from the upstream branch (`branchRef`, e.g.
 * `cella-upstream/main`) or from an upstream release tag (remote-scoped namespace).
 */
async function isPublishedUpstream(cwd: string, remoteName: string, branchRef: string, sha: string): Promise<boolean> {
  const containing = await git(
    [
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      '--contains',
      sha,
      `refs/remotes/${branchRef}`,
      `refs/${remoteName}/tags/[0-9]*`,
      `refs/${remoteName}/tags/v[0-9]*`,
    ],
    cwd,
  );
  return containing !== '';
}
