import { z } from 'zod';

// Public API for cella/cella.config.ts.

const packageJsonKeys = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'scripts',
  'engines',
  'packageManager',
  'overrides',
  'exports',
  'pnpm',
] as const;

/** Valid package.json keys that can merge from upstream */
export type PackageJsonKey = (typeof packageJsonKeys)[number];

/**
 * Configuration for a downstream fork repository that cella interacts with.
 *
 * Cella is the upstream/source-of-truth: the adopt command pulls contributions FROM the fork's `pullBranch`.
 */
export interface ForkConfig {
  /** Display name for the fork (also used as the contrib/<name> branch slug) */
  name: string;
  /** Local path to the fork repository (relative to this config or absolute) */
  localPath: string;
  /**
   * Git remote URL of the fork (e.g. 'git@github.com:org/fork.git').
   * When set, the adopt command fetches the fork's `pullBranch` from this
   * remote (the authoritative committed ref), so the comparison does not depend on
   * the local checkout being up to date. The local clone is still used to read the
   * fork's owned-folder territory when available.
   */
  remoteUrl?: string;
  /** Fork branch that cella pulls contributions from (adopt command) */
  pullBranch: string;
}

/** The app's cella/cella.config.ts. Paths in `ignored` and `pinned` are exact files or folders, never globs. */
export interface CellaCliConfig {
  /** Upstream repository URL, e.g. 'git@github.com:cellajs/cella.git'. */
  upstreamUrl: string;

  /** Upstream branch that `upstreamTrack: 'branch'` follows and GitHub file links read (default: 'main'). */
  upstreamBranch?: string;

  /** 'release' (default) upgrades to the latest upstream release tag, 'branch' to the tip of `upstreamBranch`. */
  upstreamTrack?: 'release' | 'branch';

  /** The app's main branch: `cella upgrade` cuts its branch from it and opens the PR into it (default: 'main'). */
  trunk?: string;

  /** Keys each package.json merges from upstream, plus `type` (default: dependencies, devDependencies); false: none. */
  packageJsonKeys?: PackageJsonKey[] | false;

  /** CLI output links a file to the commit that changed it ('commit', default) or to the file at `upstreamBranch`. */
  fileLinkMode?: 'commit' | 'file';

  /** Paths the app owns whole: upstream never adds, changes or deletes anything under them. */
  ignored?: string[];

  /** Paths where the app's copy wins whole-file: upstream's changes drop, and analyze lists them to adopt by hand. */
  pinned?: string[];

  /** Downstream forks the template pulls contributions from (`cella adopt`). */
  forks?: ForkConfig[];
}

/**
 * Helper function for defining cella/cella.config.ts with type checking.
 */
export function defineConfig(config: CellaCliConfig): CellaCliConfig {
  return config;
}

/**
 * Strict runtime schema mirroring {@link CellaCliConfig}.
 *
 * The TS interfaces above stay the source of truth (and keep their hover docs for
 * config authors). This schema is what's enforced at load time: `.strict()` rejects
 * unknown keys, so a typo like `ignoredFolders` for `ignored` fails closed; a silent
 * fallback would drop upgrade protection (tsx does not typecheck the config).
 *
 * The `satisfies z.ZodType<CellaCliConfig>` assertion keeps schema and interface in
 * lockstep: if either drifts (a renamed/removed/mis-typed field), TypeScript errors here.
 */
export const cellaConfigSchema = z
  .object({
    upstreamUrl: z.string().min(1),
    upstreamBranch: z.string().min(1).optional(),
    upstreamTrack: z.enum(['release', 'branch']).optional(),
    trunk: z.string().min(1).optional(),
    packageJsonKeys: z.union([z.array(z.enum(packageJsonKeys)), z.literal(false)]).optional(),
    fileLinkMode: z.enum(['commit', 'file']).optional(),
    ignored: z.array(z.string()).optional(),
    pinned: z.array(z.string()).optional(),
    forks: z
      .array(
        z
          .object({
            name: z.string().min(1),
            localPath: z.string().min(1),
            remoteUrl: z.string().optional(),
            pullBranch: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict() satisfies z.ZodType<CellaCliConfig>;

/** How one analyze or upgrade run picks and merges upstream. */
export interface EngineOptions {
  /**
   * Override upstream tracking for this run (analyze/upgrade), ignoring the config's `upstreamTrack`.
   * 'branch' follows the upstream branch tip (bleeding edge); 'release' uses a release tag.
   */
  track?: 'release' | 'branch';

  /**
   * Pin the upstream ref for this run (analyze/upgrade), overriding `track`: a commit sha, a release
   * tag or an upstream branch name. Must be on the upstream branch or in an upstream release.
   */
  ref?: string;

  /**
   * Merge with the app's CLI config as it stands (upgrade). Without it, a new merge stops
   * before anything changes when upstream changed its own `ignored`, `pinned` or `packageJsonKeys` in ways
   * the app config does not follow.
   */
  keepConfig?: boolean;

  /**
   * Lift every pinned entry for this run (analyze, upgrade): managed files stay pinned, and the merge
   * uses the full upstream history, so upstream changes that earlier upgrades dropped come back too.
   */
  unpinned?: boolean;
}

/** What the upstream commands run on: the app's config, the repository and the upstream ref, and the engine's options. */
export interface RuntimeConfig extends CellaCliConfig, EngineOptions {
  /** The repository the command runs in */
  repoRoot: string;

  /** The upstream branch tip as last fetched (`cella-upstream/main`); analyze and upgrade resolve the ref they merge from. */
  upstreamRef: string;
}
