/**
 * Configuration types: the public cella/cella.config.ts surface, its runtime
 * schema, and the internal types the upstream commands share.
 */

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

// Internal types for the upstream commands.

/** Analyze output scope for interactive and machine-readable flows */
export type AnalyzeScope = 'all' | 'risk' | 'protected';

/** How one run of the merge engine picks and merges upstream: the options analyze and upgrade read. */
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

  /** Full upstream remote ref (e.g., 'cella-upstream/development') */
  upstreamRef: string;
}

/** File status after analysis */
export type FileStatus =
  | 'identical' // No changes needed
  | 'ahead' // The app is ahead, protected (pinned/ignored)
  | 'local' // Local file (never existed upstream)
  | 'drifted' // The app is ahead, NOT protected (at risk)
  | 'behind' // Upstream has changes to merge
  | 'diverged' // Both changed, will merge
  | 'pinned' // The app wins on conflict
  | 'ignored' // Excluded from the upgrade entirely
  | 'deleted' // The app deleted it, it stays deleted
  | 'renamed'; // Upstream renamed file

/** Statuses the upgrade applies changes for: a staged upgrade holds at least one file with one of these. */
export const upgradeAppliedStatuses: readonly FileStatus[] = ['behind', 'diverged', 'renamed', 'ignored', 'pinned'];

/** Commit metadata for a single log entry */
export interface CommitRangeEntry {
  hash: string;
  message: string;
  date: string;
  /** Unix epoch seconds of the commit */
  timestamp?: number;
}

/** Analyzed file with status and metadata */
export interface AnalyzedFile {
  path: string;
  status: FileStatus;
  /** True if file is in ignored list */
  isIgnored: boolean;
  /** True if file is in pinned list */
  isPinned: boolean;
  /** True if the file exists in the app */
  existsInApp: boolean;
  /** True if file exists in upstream */
  existsInUpstream: boolean;
  /** Relative date when file was last changed (since merge-base) */
  changedAt?: string;
  /** Unix epoch seconds of the last change, for sorting */
  changedTs?: number;
  /** Short commit hash of the last change */
  changedCommit?: string;
  /** For diverged files: relative date of upstream change */
  upstreamChangedAt?: string;
  /** For diverged files: Unix epoch seconds of the upstream change, for sorting */
  upstreamChangedTs?: number;
  /** For diverged files: short commit hash of the upstream change */
  upstreamCommit?: string;
  /** For renamed files: the original path before rename */
  renamedFrom?: string;
  /**
   * Protected (pinned/ignored) files only: both sides changed since the merge-base. The app
   * side wins whole-file, so upstream's changes to this path are dropped by the upgrade.
   */
  upstreamChanged?: boolean;
  /** For `upstreamChanged` and `upstreamOnly` files: lines upstream changed since the merge-base (undefined for binary) */
  upstreamChangedLines?: number;
  /** For `upstreamChanged` and `upstreamOnly` files: upstream's change is binary, which has no line count. */
  upstreamBinary?: boolean;
  /**
   * Ignored files only: upstream changed, added or deleted the file since the merge-base and the
   * app did not touch it. Ignored paths never merge, so without this flag the change stays unseen
   * (new config keys, version bumps). Managed files and generated output (`isGeneratedFile`) are
   * never flagged.
   */
  upstreamOnly?: boolean;
  /**
   * Pinned `ahead` files only: lines present upstream but absent from the app (undefined for
   * binary). Independent of the upgrade point, so it also shows upstream content dropped by an
   * earlier upgrade, or removed on purpose; only a diff can tell.
   */
  upstreamLinesAbsent?: number;
}

/** Summary counts by status */
export interface AnalysisSummary {
  /** Changed package/config files that are handled separately from the normal merge categories */
  managed: number;
  identical: number;
  ahead: number;
  local: number;
  drifted: number;
  behind: number;
  diverged: number;
  pinned: number;
  ignored: number;
  deleted: number;
  renamed: number;
}

/** Merge result from merge-engine */
export interface MergeResult {
  /** Upstream branch name for file links */
  upstreamBranch?: string;
  /** Resolved concrete upstream ref that was merged (branch ref or release tag ref) */
  upstreamRef?: string;
  files: AnalyzedFile[];
  summary: AnalysisSummary;
  conflicts: string[];
  /** Upstream GitHub URL base for commit links */
  upstreamGitHubUrl?: string;
  /** Upstream commit info */
  upstreamCommit?: CommitRangeEntry;
  /** Upstream commits since the upgrade point */
  upstreamCommitCount?: number;
  /** Files that were auto-merged by git (diverged without remaining conflicts) */
  autoMergedFiles?: string[];
  /**
   * Protected (pinned/ignored) files resolved to the app side although upstream also changed
   * them: upstream's hunks were dropped, not merged. Review each against upstream.
   */
  protectedConflicts?: string[];
  /** `<merge-base>..<upstream>` range of short SHAs: what upstream changed since the last upgrade, for the review page. */
  upstreamDiffRange?: string;
  /** How upstream's own CLI config changed since the merge-base, where the app config does not follow. */
  upstreamOverrides?: UpstreamOverridesReport;
  /** Files flagged `upstreamOnly`, grouped by the `ignored` entry they fall under (config order). */
  ignoredUpstreamChanges?: IgnoredUpstreamGroup[];
  /**
   * Upstream alignments: how many the incoming ref holds, which ones upstream added since the
   * upgrade point, and the ones open in the app after the run. An upgrade opens the arrivals; a dry run
   * leaves them out of `open`.
   */
  alignments?: { total: number; arrived: string[]; open: string[] };
}

/** Entries of one CLI config list (`pinned`, `ignored` or `packageJsonKeys`) that the app config does not mirror. */
export interface OverrideListChanges {
  /** Entries upstream added since the merge-base that the app list lacks. */
  added: string[];
  /** Entries upstream removed since the merge-base that the app list still carries. */
  removed: string[];
  /** Entries upstream renamed that the app never carried under either path: informational, never a stop. */
  moved?: { from: string; to: string }[];
}

/**
 * Upstream CLI config changes the app should review. The CLI config is managed (never merged),
 * so new upstream `pinned`/`ignored` entries and `packageJsonKeys` only reach the app by
 * hand. `unreadable` means upstream's config was missing or unparsable at one side (`base` =
 * merge-base, `incoming` = upstream ref), so nothing was compared.
 */
export type UpstreamOverridesReport =
  | {
      type: 'changes';
      pinned: OverrideListChanges;
      ignored: OverrideListChanges;
      packageJsonKeys: OverrideListChanges;
    }
  | { type: 'unreadable'; side: 'base' | 'incoming' };

/** Upstream-only changes under one `ignored` entry. */
export interface IgnoredUpstreamGroup {
  /** The `ignored` entry (configured or derived from an app-owned module) the files fall under. */
  entry: string;
  /** Changed paths under the entry, sorted. */
  paths: string[];
  /** Paths the app lacks (new upstream files). */
  added: number;
  /** Paths upstream deleted (the app keeps them). */
  deleted: number;
}
