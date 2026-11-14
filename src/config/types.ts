/**
 * Configuration types: the public cella/cella.config.ts surface, its runtime
 * schema, and the internal types the services share.
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
 * Settings: all configurable options for the cella CLI.
 * Hover over each property for documentation.
 */
export interface UpgradeSettings {
  /** Upstream repository URL (e.g., 'git@github.com:cellajs/cella.git') */
  upstreamUrl: string;

  /**
   * Upstream branch, used for `upstreamTrack: 'branch'` and for GitHub file links.
   * Defaults to 'main'.
   */
  upstreamBranch?: string;

  /**
   * How to track upstream cella. Defaults to 'release'.
   * - 'release' (default): upgrade to a published cella release tag (`0.18.1`, with or without `v`). Stable and
   *   reviewable: each bump maps to a changelog. Uses the latest release.
   * - 'branch': follow the bleeding-edge tip of `upstreamBranch`. For cella
   *   maintainers and apps doing active development on top of unreleased changes.
   */
  upstreamTrack?: 'release' | 'branch';

  /**
   * Trunk branch that `pnpm cella upgrade` cuts the temporary branch from and that you open the
   * squash-merge PR into. Defaults to 'main'. Cutting fresh from trunk each cycle keeps every
   * PR limited to that cycle's upstream delta (no accumulation) and `main` linear.
   */
  releaseBase?: string;

  /** Which package.json keys merge from upstream (default: ['dependencies', 'devDependencies']). `type` always merges. */
  packageJsonKeys?: PackageJsonKey[];

  /** Merge the `packageJsonKeys` of every package.json after the upgrade merge (default: true). */
  mergePackageJson?: boolean;

  /**
   * How to link files in CLI output.
   * - 'commit' (default): Link to the commit that changed the file on GitHub.
   * - 'file': Link to the file in the repo at the upstream branch on GitHub.
   */
  fileLinkMode?: 'commit' | 'file';
}

/**
 * Configuration for a downstream fork repository that cella interacts with.
 *
 * Cella is the upstream/source-of-truth: the adopt service pulls contributions FROM the fork's `pullBranch`.
 */
export interface ForkConfig {
  /** Display name for the fork (also used as the contrib/<name> branch slug) */
  name: string;
  /** Local path to the fork repository (relative to this config or absolute) */
  localPath: string;
  /**
   * Git remote URL of the fork (e.g. 'git@github.com:org/fork.git').
   * When set, the adopt service fetches the fork's `pullBranch` from this
   * remote (the authoritative committed ref), so the comparison does not depend on
   * the local checkout being up to date. The local clone is still used to read the
   * fork's owned-folder territory when available.
   */
  remoteUrl?: string;
  /** Fork branch that cella pulls contributions from (adopt service) */
  pullBranch: string;
}

/** User-configurable upgrade options for cella/cella.config.ts. */
export interface CellaCliConfig {
  /** Core upgrade settings */
  settings: UpgradeSettings;

  /**
   * File overrides for controlling upgrade behavior per folder/file.
   */
  overrides?: {
    /**
     * Paths the app fully owns: never merged (existing or new).
     * Exact paths or directory prefixes, not globs: 'bench' matches 'bench/' and
     * everything under it, 'README.md' matches that exact file.
     * Local territory: upstream cannot add, modify, or delete anything under these.
     */
    ignored?: string[];

    /**
     * Paths pinned to the app: the app copy wins whole-file.
     * Exact paths or directory prefixes, not globs: 'bench' matches 'bench/' and
     * everything under it, 'README.md' matches that exact file.
     * Upstream changes to a pinned file are dropped, not merged: analyze lists them under
     * "protected but behind upstream" to adopt by hand.
     * If the app deleted a pinned file, deletion is respected.
     */
    pinned?: string[];
  };

  /**
   * Downstream fork repositories that cella interacts with (for upstream template repos).
   * When configured, the 'adopt' service appears in the CLI menu.
   */
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
    settings: z
      .object({
        upstreamUrl: z.string().min(1),
        upstreamBranch: z.string().min(1).optional(),
        upstreamTrack: z.enum(['release', 'branch']).optional(),
        releaseBase: z.string().min(1).optional(),
        packageJsonKeys: z.array(z.enum(packageJsonKeys)).optional(),
        mergePackageJson: z.boolean().optional(),
        fileLinkMode: z.enum(['commit', 'file']).optional(),
      })
      .strict(),
    overrides: z
      .object({
        ignored: z.array(z.string()).optional(),
        pinned: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
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

// Internal types for the services.

/** Services available in the CLI */
export type CliService = 'analyze' | 'upgrade' | 'align' | 'audit' | 'adopt';

/** A command's `--help` heading and menu place; a gate shows in `--help` only, since scripts and CI run it. */
export type CommandGroup = 'develop' | 'security' | 'upstream' | 'gate';

export type CommandOption = [flags: string, description: string];

/**
 * A command that runs without the upgrade config: no `cella.config.ts`, no override validation. It declares its own
 * options, parses them into its own shape and returns its exit code.
 */
export interface ToolCommand<Options = unknown> {
  name: string;
  group: Exclude<CommandGroup, 'upstream'>;
  /** Left out of the menu: the app runs it through a root script of its own, `pnpm <name>`. */
  notInMenu?: true;
  description: string;
  /** The jobs its first operand names, the default first; the menu asks for one. Empty: the command has one job. */
  jobs: [name: string, description: string][];
  /**
   * The words it takes after the job, in commander's notation such as `[scenario]` or `[paths...]`; none when unset.
   * A command takes these or a passthrough, never both.
   */
  operands?: CommandOption;
  options?: CommandOption[];
  /** What the words after `--` are for, in `--help`. */
  passthrough?: CommandOption;
  parse(input: { job?: string; operands: string[]; opts: Record<string, unknown>; passthrough: string[] }): Options;
  run(repoRoot: string, options: Options): Promise<number>;
}

/** Analyze output scope for interactive and machine-readable flows */
export type AnalyzeScope = 'all' | 'risk' | 'protected';

/** Runtime configuration with all resolved values */
export interface RuntimeConfig extends CellaCliConfig {
  /** The repository the command runs in */
  repoRoot: string;

  /** Full upstream remote ref (e.g., 'cella-upstream/development') */
  upstreamRef: string;

  /** Selected service */
  service: CliService;

  /** Non-interactive list output (for LLM/agent usage) */
  list: boolean;

  /** Machine-readable JSON output (for tooling/agent usage) */
  json: boolean;

  /** Scope of files returned in analyze list/json output */
  scope?: AnalyzeScope;

  /** Pre-selected fork name (skips fork selection prompt) */
  fork?: string;

  /**
   * Override upstream tracking for this run (analyze/upgrade), ignoring `settings.upstreamTrack`.
   * 'branch' follows the upstream branch tip (bleeding edge); 'release' uses a release tag.
   */
  track?: 'release' | 'branch';

  /**
   * Pin the upstream ref for this run (analyze/upgrade), overriding `track`: a commit sha, a release
   * tag or an upstream branch name. Must be on the upstream branch or in an upstream release.
   */
  ref?: string;

  /**
   * Merge with the app's CLI config as it stands (upgrade service). Without it, a new merge stops
   * before anything changes when upstream changed its own `overrides` or `packageJsonKeys` in ways
   * the app config does not follow.
   */
  keepConfig?: boolean;

  /**
   * Lift every pinned entry for this run (analyze, upgrade): managed files stay pinned, and the merge
   * uses the full upstream history, so upstream changes that earlier upgrades dropped come back too.
   */
  unpinned?: boolean;

  /** List every file instead of collapsing large groups (analyze), or every upstream alignment (align) */
  all?: boolean;

  /** Print one alignment's README (align service) */
  show?: string;

  /** Write one alignment's folder where its codemod can run (align service) */
  extract?: string;

  /** Run one alignment's codemod, keeping files identical to upstream as they are (align service) */
  run?: string;

  /** Arguments after `--`, passed to the codemod as given (align service, with `run`) */
  runArgs?: string[];

  /** Alignment ids to record as handled (align service) */
  mark?: string[];
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
