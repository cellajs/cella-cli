/**
 * Review page: one browser page per analyze or sync run, holding the diff of every file the run
 * asks you to review, under the same sections the terminal prints.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { MergeResult } from '../config/types';
import pc from '../utils/colors';
import { type DiffPageSection, diffPagePath, gitDiffFile, openInBrowser, writeDiffPage } from '../utils/diff';
import {
  createSpinner,
  filesWithStatus,
  findMaskingPins,
  findProtectedBehind,
  hyperlink,
  type NextStep,
  plural,
  spinnerSuccess,
} from '../utils/display';

/**
 * What one page renders at most; the rest is listed by path. A rendered patch line costs about
 * 0.6 KB of page, so the line budget keeps a page near 9 MB: 42 drizzle snapshot diffs once made
 * a 164 MB page that browsers could not open.
 */
export interface ReviewPageLimits {
  /** Diffs on the page, each ~60 ms to render */
  files: number;
  /** Patch lines across the page */
  lines: number;
  /** Patch lines of one file: a larger patch would take a large share of the page */
  patchLines: number;
}

const PAGE_LIMITS: ReviewPageLimits = { files: 50, lines: 15_000, patchLines: 2_000 };

/** Larger patches are listed without counting their lines: highlighting them stalls the run. */
const MAX_PATCH_BYTES = 512 * 1024;

/** What {@link writeReviewPage} wrote: the page, its diffs, and the files it lists without one. */
export interface ReviewPage {
  path: string;
  diffs: number;
  listed: number;
  sections: number;
}

/** The files of one terminal list, and the `from..to` refs their diffs run over. */
export interface ReviewSection {
  title: string;
  /** What the diffs show and why the files are listed */
  hint: string;
  range: string;
  paths: string[];
}

/**
 * The review page's sections for a run, from the same lists the terminal prints. Sync shows the
 * upstream changes it did not bring in; analyze adds pinned files missing upstream lines and the
 * fork's own changes to files that still sync. Analyze lists ignored files only upstream changed
 * under protected but behind upstream, as its terminal does. Empty sections are left out, and so is
 * every section when the engine could not resolve the sync range.
 */
export function reviewSections(result: MergeResult, command: 'analyze' | 'sync'): ReviewSection[] {
  const [base, upstream] = result.upstreamDiffRange?.split('..') ?? [];
  if (!base || !upstream) return [];
  const sinceSync = `${base}..${upstream}`;
  const ignoredOnly = (result.ignoredUpstreamChanges ?? []).flatMap((group) => group.paths);

  const sections: ReviewSection[] =
    command === 'sync'
      ? [
          {
            title: 'protected files kept the fork version',
            hint: 'What upstream changed in these files since the last sync. The fork kept its own version, so none of it arrived: adopt what you need.',
            range: sinceSync,
            paths: result.protectedConflicts ?? [],
          },
          {
            title: 'ignored paths changed upstream',
            hint: 'What upstream changed under ignored paths since the last sync. The fork left these files untouched, and ignored paths never sync.',
            range: sinceSync,
            paths: ignoredOnly,
          },
        ]
      : [
          {
            title: 'protected but behind upstream',
            hint: 'What upstream changed in these files since the last sync. They are pinned or ignored, so the sync keeps the fork version and none of it arrives: adopt what you need.',
            range: sinceSync,
            paths: [...findProtectedBehind(result.files).map((file) => file.path), ...ignoredOnly],
          },
        ];

  sections.push({
    title: 'pinned files that match the previous upstream',
    hint: 'What upstream changed in these files since the last sync. The fork copy still equals the previous upstream, so the pin only drops these changes: unpin to take them.',
    range: sinceSync,
    paths: findMaskingPins(result.files).map((file) => file.path),
  });

  if (command === 'analyze') {
    sections.push(
      {
        title: 'protected in fork, upstream lines absent',
        hint: "The fork's version against upstream's, both as they are now: added lines are upstream content the fork does not have, dropped by an earlier sync or removed on purpose.",
        range: `HEAD..${upstream}`,
        paths: filesWithStatus(result.files, 'ahead')
          .filter((file) => (file.upstreamLinesAbsent ?? 0) > 0)
          .map((file) => file.path),
      },
      {
        title: 'drifted from upstream',
        hint: 'What the fork changed in these files since the last sync. They are not pinned or ignored, so upstream changes still merge into them.',
        range: `${base}..HEAD`,
        paths: filesWithStatus(result.files, 'drifted').map((file) => file.path),
      },
    );
  }

  return sections.filter((section) => section.paths.length > 0);
}

/** Lines in a patch, without decoding it. */
function countLines(patch: Buffer): number {
  let count = 0;
  for (let at = patch.indexOf(10); at !== -1; at = patch.indexOf(10, at + 1)) count++;
  return count;
}

/**
 * Write the review page for `sections` and return its path, its diffs and the files it lists
 * without one. Sections take turns, one file each, so a section of large diffs cannot fill the
 * page before the next gets any. Files past the page limits, oversized patches and patches without
 * a text hunk (binary, mode only) are listed by path. Undefined when no file has a diff.
 */
export async function writeReviewPage(
  forkPath: string,
  sections: ReviewSection[],
  meta: { command: 'analyze' | 'sync'; range: string },
  limits: ReviewPageLimits = PAGE_LIMITS,
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
      const patch = gitDiffFile(forkPath, sections[index].range, path);
      if (patch.length === 0) continue;
      const patchLines = patch.length > MAX_PATCH_BYTES ? Number.POSITIVE_INFINITY : countLines(patch);
      if (patchLines > limits.patchLines || lines + patchLines > limits.lines || !patch.includes('\n@@ ')) {
        pageSection.omitted.push(path);
        continue;
      }
      pageSection.files.push({ path, patch: patch.toString() });
      diffs++;
      lines += patchLines;
    }
  }

  if (diffs === 0) return undefined;
  const shown = pageSections.filter((section) => section.files.length > 0 || section.omitted.length > 0);
  const page = await writeDiffPage(
    shown,
    { title: `${meta.command} review`, note: `${basename(forkPath)} · last sync ${base} → upstream ${upstream}` },
    forkPath,
    `${meta.command}-review`,
  );
  const listed = shown.reduce((count, section) => count + section.omitted.length, 0);
  return { path: page, diffs, listed, sections: shown.length };
}

/** A written review page, and whether the run opened it in the browser. */
export interface ReviewPageReport extends ReviewPage {
  command: 'analyze' | 'sync';
  opened: boolean;
}

/**
 * After an analyze or sync report: write the review page. Sync opens it in the browser when
 * stdout is a terminal, since the upstream changes it lists did not arrive. Undefined when there
 * is nothing to review; a failure is undefined too and never fails the run.
 */
export async function reportReviewPage(
  forkPath: string,
  result: MergeResult,
  command: 'analyze' | 'sync',
): Promise<ReviewPageReport | undefined> {
  const sections = reviewSections(result, command);
  if (sections.length === 0 || !result.upstreamDiffRange) return undefined;

  createSpinner('writing review page...');
  let page: ReviewPage | undefined;
  try {
    page = await writeReviewPage(forkPath, sections, { command, range: result.upstreamDiffRange });
  } catch {
    page = undefined;
  }
  spinnerSuccess();
  if (!page) return undefined;

  const opened = command === 'sync' && process.stdout.isTTY === true && openInBrowser(page.path);
  return { ...page, command, opened };
}

/** The sync review page an earlier run of this sync wrote, when it is still there. */
export function existingSyncReviewPage(forkPath: string): string | undefined {
  try {
    const path = diffPagePath(forkPath, 'sync-review');
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
  let detail = pc.dim('upstream changes the sync did not bring in, from the merge run');
  if (typeof page !== 'string') {
    const what =
      page.command === 'sync'
        ? `${plural(page.diffs, 'diff')} of upstream changes that did not arrive`
        : `${plural(page.diffs, 'diff')} in ${plural(page.sections, 'section')}`;
    const notes = [
      page.listed > 0 ? `${page.listed} listed without a diff` : '',
      page.opened ? 'opened in the browser' : '',
    ]
      .filter(Boolean)
      .map((note) => ` · ${note}`)
      .join('');
    detail = `${what}${notes ? pc.dim(notes) : ''}`;
  }
  return { label: 'review', line: hyperlink(pc.cyan(url), url), details: [detail] };
}
