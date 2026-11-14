import type { CommitRangeEntry } from '../utils/git';

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

/** Upstream as one analyze or upgrade run resolved it. */
export interface UpstreamContext {
  /** The ref merged from: the upstream branch tip, a release tag ref or a `--ref` commit sha */
  ref: string;
  /** The release tag when the run moves to a release */
  releaseTag?: string;
  /** The last upgrade point: the base of the 3-way analysis */
  mergeBase: string;
  /** The base of the merge itself: the upgrade point, or git's own merge base under `--unpinned` */
  mergeRef: string;
  /** The commit `ref` names */
  commit: CommitRangeEntry;
  /** Upstream commits since the upgrade point */
  commitCount: number;
  /** Upstream's GitHub repository, for links */
  gitHub?: { slug: string; url: string };
}

/** What an analyze or upgrade run found, and for an upgrade what it merged. */
export interface MergeResult {
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
