import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import pc from '../utils/colors';
import { createSpinner, hyperlink, type NextStep, plural, spinnerSuccess, warningMark } from '../utils/display';
import { git } from '../utils/git';
import { printable } from '../utils/terminal-text';
import { type DiffPageSection, diffPagePath, gitDiffFile, openInBrowser, writeDiffPage } from './diff-page';
import type { MergeResult } from './model';
import { filesWithStatus, findMaskingPins, findProtectedBehindUpstream } from './report';

/** Paths whose change decides what `pnpm install`, `pnpm check`, a git hook or CI runs. */
const runConfigPath =
  /^(\.github\/(workflows|actions)\/|patches\/|(pnpm-workspace\.yaml|(\.config\/)?\.?lefthook(-local)?\.(ya?ml|json|toml)|\.pnpmfile\.[cm]?js|(.*\/)?(\.npmrc|action\.ya?ml))$)/;

/** The package.json keys whose entries install a package. */
const dependencyKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** A package.json as far as {@link packageRunEntries} reads it. */
type PackageEntries = Record<string, Record<string, unknown> | undefined>;

/** A changed file that decides what runs. */
export interface RunChange {
  path: string;
  /** For a package.json that parses: what in it changed that decides what runs; empty for the whole file */
  entries: string[];
}

/**
 * Whether a dependency spec resolves from the registry under its own name or inside the merged tree: a semver range,
 * `workspace:` or `catalog:`. A tag, a URL, a path, a git spec or an `npm:` alias, which puts another package under
 * the name, is not.
 */
function registrySpec(spec: unknown): boolean {
  if (typeof spec !== 'string') return false;
  return /^(workspace|catalog):/.test(spec) || semver.validRange(spec) !== null;
}

/** The entries of one package.json change that decide what runs: scripts, the `pnpm` field, specs off the registry. */
function packageRunEntries(before: PackageEntries, after: PackageEntries): string[] {
  const entries = JSON.stringify(before.pnpm) === JSON.stringify(after.pnpm) ? [] : ['pnpm'];
  for (const key of ['scripts', ...dependencyKeys]) {
    const [was, now] = [before[key] ?? {}, after[key] ?? {}];
    for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const spec = now[name];
      if (spec === was[name]) continue;
      // An entry the merge removed runs nothing
      if (spec === undefined) continue;
      if (key === 'scripts') entries.push(`scripts.${name}`);
      else if (!registrySpec(spec)) entries.push(`${key}.${name} ${String(spec)}`);
    }
  }
  return entries;
}

/**
 * What the change from commit `from` to `to` (the working tree when absent) brings that decides what
 * runs: the files {@link runConfigPath} matches, and each package.json whose scripts, `pnpm` field
 * or dependency specs off the registry change. A package.json that does not parse is listed whole.
 */
export async function listRunChanges(repoRoot: string, from: string, to?: string): Promise<RunChange[]> {
  const diff = await git(['diff', '-z', '--name-only', '--no-renames', from, ...(to ? [to] : [])], repoRoot);
  // A file the merge wrote and did not stage is in no diff against a commit
  const untracked = to ? '' : await git(['ls-files', '-z', '--others', '--exclude-standard'], repoRoot);
  const read = async (ref: string | undefined, path: string): Promise<PackageEntries | null> => {
    const file = join(repoRoot, path);
    let raw = '';
    if (ref) raw = await git(['show', `${ref}:${path}`], repoRoot, { ignoreErrors: true });
    try {
      // A package.json that is a folder, or a symlink to one, is listed whole
      if (!ref && existsSync(file)) raw = readFileSync(file, 'utf8');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return null;
    }
  };

  const changes: RunChange[] = [];
  for (const path of `${diff}\0${untracked}`.split('\0').filter(Boolean)) {
    if (runConfigPath.test(path)) changes.push({ path, entries: [] });
    if (!/(^|\/)package\.json$/.test(path)) continue;
    const [before, after] = await Promise.all([read(from, path), read(to, path)]);
    const entries = before && after ? packageRunEntries(before, after) : [];
    if (!before || !after || entries.length > 0) changes.push({ path, entries });
  }
  return changes;
}

/** Print `changes` under a warning `header`, one `→ path entries` line each; nothing without changes. */
export function printRunChanges(header: string, changes: RunChange[]): void {
  if (changes.length === 0) return;
  console.info();
  console.info(`${warningMark} ${pc.yellow(header)}`);
  for (const { path, entries } of changes) {
    const detail = entries.length > 0 ? ` ${pc.dim(printable(entries.join(', ')))}` : '';
    console.info(`    ${pc.dim('→')} ${printable(path)}${detail}`);
  }
}

/**
 * What one page renders at most; the rest is listed by path. A rendered patch line costs about
 * 0.6 KB of page, so the line budget keeps a page near 9 MB: 42 drizzle snapshot diffs once made
 * a 164 MB page that browsers could not open.
 */
interface ReviewPageLimits {
  /** Diffs on the page, each ~60 ms to render */
  files: number;
  /** Patch lines across the page */
  lines: number;
  /** Patch lines of one file: a larger patch would take a large share of the page */
  patchLines: number;
}

const pageLimits: ReviewPageLimits = { files: 50, lines: 15_000, patchLines: 2_000 };

/** Patches longer than this (characters) are listed without counting their lines: highlighting them stalls the run. */
const maxPatchLength = 512 * 1024;

/** What {@link writeReviewPage} wrote: the page, its diffs, and the files it lists without one. */
interface ReviewPage {
  path: string;
  diffs: number;
  listed: number;
  sections: number;
}

/** The files of one terminal list, and the `from..to` refs their diffs run over. */
interface ReviewSection {
  title: string;
  /** What the diffs show and why the files are listed */
  hint: string;
  range: string;
  paths: string[];
}

/**
 * The review page's sections for a run, from the same lists the terminal prints. Upgrade shows
 * `arrived`, the files the merge in the working tree changes that decide what runs, then the
 * upstream changes it did not bring in; analyze adds pinned files missing upstream lines and the
 * app's own changes to files that still merge. Analyze lists ignored files only upstream changed
 * under protected but behind upstream, as its terminal does. Empty sections are left out, and so is
 * every section when the engine could not resolve the upgrade range.
 */
export function reviewSections(result: MergeResult, command: 'analyze' | 'upgrade', arrived: string[] = []): ReviewSection[] {
  const [base, upstream] = result.upstreamDiffRange?.split('..') ?? [];
  if (!base || !upstream) return [];
  const sinceUpgradePoint = `${base}..${upstream}`;

  const sections: ReviewSection[] =
    command === 'upgrade'
      ? [
          {
            title: 'arrived and decides what runs',
            hint: 'What the merge changes in files that decide what an install, pnpm check, a git hook or CI runs. Nothing has run yet: read these before the rerun installs and checks.',
            range: 'HEAD',
            paths: arrived,
          },
          {
            title: 'protected files kept the app version',
            hint: 'What upstream changed in these files since the last upgrade. The app kept its own version, so none of it arrived: adopt what you need.',
            range: sinceUpgradePoint,
            paths: result.protectedConflicts ?? [],
          },
          {
            title: 'ignored paths changed upstream',
            hint: 'What upstream changed under ignored paths since the last upgrade. The app left these files untouched, and ignored paths never merge.',
            range: sinceUpgradePoint,
            paths: (result.ignoredUpstreamChanges ?? []).flatMap((group) => group.paths),
          },
        ]
      : [
          {
            title: 'protected but behind upstream',
            hint: 'What upstream changed in these files since the last upgrade. They are pinned or ignored, so the upgrade keeps the app version and none of it arrives: adopt what you need.',
            range: sinceUpgradePoint,
            paths: findProtectedBehindUpstream(result).map((file) => file.path),
          },
        ];

  sections.push({
    title: 'pinned files that match the previous upstream',
    hint: 'What upstream changed in these files since the last upgrade. The app copy still equals the previous upstream, so the pin only drops these changes: unpin to take them.',
    range: sinceUpgradePoint,
    paths: findMaskingPins(result.files).map((file) => file.path),
  });

  if (command === 'analyze') {
    sections.push(
      {
        title: 'protected in app, upstream lines absent',
        hint: "The app's version against upstream's, both as they are now: added lines are upstream content the app does not have, dropped by an earlier upgrade or removed on purpose.",
        range: `HEAD..${upstream}`,
        paths: filesWithStatus(result.files, 'ahead')
          .filter((file) => (file.upstreamLinesAbsent ?? 0) > 0)
          .map((file) => file.path),
      },
      {
        title: 'drifted from upstream',
        hint: 'What the app changed in these files since the last upgrade. They are not pinned or ignored, so upstream changes still merge into them.',
        range: `${base}..HEAD`,
        paths: filesWithStatus(result.files, 'drifted').map((file) => file.path),
      },
    );
  }

  return sections.filter((section) => section.paths.length > 0);
}

/**
 * Write the review page for `sections` and return its path, its diffs and the files it lists
 * without one. Sections take turns, one file each, so a section of large diffs cannot fill the
 * page before the next gets any. Files past the page limits, oversized patches and patches without
 * a text hunk (binary, mode only) are listed by path. Undefined when no file has a diff.
 */
export async function writeReviewPage(
  repoRoot: string,
  sections: ReviewSection[],
  meta: { command: 'analyze' | 'upgrade'; range: string },
  limits: ReviewPageLimits = pageLimits,
): Promise<ReviewPage | undefined> {
  const [base, upstream] = meta.range.split('..');
  const pageSections: Array<Required<DiffPageSection>> = sections.map((section) => ({
    title: section.title,
    hint: section.hint,
    files: [],
    omitted: [],
  }));
  const queues = sections.map((section) => [...section.paths]);
  let diffs = 0;
  let lines = 0;

  while (queues.some((queue) => queue.length > 0)) {
    for (const [index, queue] of queues.entries()) {
      const path = queue.shift();
      if (path === undefined) continue;
      const pageSection = pageSections[index];
      if (diffs >= limits.files || lines >= limits.lines) {
        pageSection.omitted.push(path);
        continue;
      }
      const patch = await gitDiffFile(repoRoot, sections[index].range, path);
      if (patch.length === 0) continue;
      const patchLines = patch.length > maxPatchLength ? Number.POSITIVE_INFINITY : patch.split('\n').length;
      if (patchLines > limits.patchLines || lines + patchLines > limits.lines || !patch.includes('\n@@ ')) {
        pageSection.omitted.push(path);
        continue;
      }
      pageSection.files.push({ path, patch });
      diffs++;
      lines += patchLines;
    }
  }

  if (diffs === 0) return undefined;
  const shown = pageSections.filter((section) => section.files.length > 0 || section.omitted.length > 0);
  const page = await writeDiffPage(
    shown,
    { title: `${meta.command} review`, note: `${basename(repoRoot)} · last upgrade ${base} → upstream ${upstream}` },
    repoRoot,
    `${meta.command}-review`,
  );
  const listed = shown.reduce((count, section) => count + section.omitted.length, 0);
  return { path: page, diffs, listed, sections: shown.length };
}

/** A written review page, and whether the run opened it in the browser. */
export interface ReviewPageReport extends ReviewPage {
  command: 'analyze' | 'upgrade';
  opened: boolean;
}

/**
 * After an analyze or upgrade report: write the review page, one browser page per run holding the
 * diff of every file the run asks you to review, under the same sections the terminal prints. Upgrade opens it in the browser when
 * stdout is a terminal, since the run stops for this review. Undefined when there
 * is nothing to review; a failure is undefined too and never fails the run. An upgrade with nothing to
 * review removes the page an earlier upgrade left, so a rerun that resumes this merge never lists it.
 */
export async function reportReviewPage(
  repoRoot: string,
  result: MergeResult,
  command: 'analyze' | 'upgrade',
  arrived?: string[],
): Promise<ReviewPageReport | undefined> {
  const sections = reviewSections(result, command, arrived);
  let page: ReviewPage | undefined;
  if (sections.length > 0 && result.upstreamDiffRange) {
    createSpinner('writing review page...');
    try {
      page = await writeReviewPage(repoRoot, sections, { command, range: result.upstreamDiffRange });
    } catch {
      page = undefined;
    }
    spinnerSuccess();
  }
  if (!page) {
    if (command === 'upgrade') await removeUpgradeReviewPage(repoRoot);
    return undefined;
  }

  const opened = command === 'upgrade' && process.stdout.isTTY === true && openInBrowser(page.path);
  return { ...page, command, opened };
}

async function removeUpgradeReviewPage(repoRoot: string): Promise<void> {
  try {
    rmSync(await diffPagePath(repoRoot, 'upgrade-review'), { force: true });
  } catch {
    // Not a git repo or no git: there is no page to remove either.
  }
}

/** The upgrade review page the merge run of this upgrade wrote, when it is still there. */
export async function existingUpgradeReviewPage(repoRoot: string): Promise<string | undefined> {
  try {
    const path = await diffPagePath(repoRoot, 'upgrade-review');
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `review` step: the page as a `file://` URL in full, so a terminal without OSC 8 links still
 * makes it clickable, and what is on it. A page from an earlier run has no counts.
 */
export function reviewStep(page: ReviewPageReport | string): NextStep {
  const path = typeof page === 'string' ? page : page.path;
  const url = pathToFileURL(path).href;
  const upgradeShows = 'what arrived that decides what runs, and upstream changes that did not';
  let detail = pc.dim(`from the merge run: ${upgradeShows}`);
  if (typeof page !== 'string') {
    const what =
      page.command === 'upgrade'
        ? `${plural(page.diffs, 'diff')}: ${upgradeShows}`
        : `${plural(page.diffs, 'diff')} in ${plural(page.sections, 'section')}`;
    const notes = [page.listed > 0 ? `${page.listed} listed without a diff` : '', page.opened ? 'opened in the browser' : '']
      .filter(Boolean)
      .map((note) => ` · ${note}`)
      .join('');
    detail = `${what}${notes ? pc.dim(notes) : ''}`;
  }
  return { label: 'review', line: hyperlink(pc.cyan(url), url), details: [detail] };
}
