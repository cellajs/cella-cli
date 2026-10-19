/**
 * Review page: one browser page per analyze or sync run, holding the diff of every file the run
 * asks you to review, under the same sections the terminal prints.
 */

import { basename } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { MergeResult } from '../config/types';
import pc from '../utils/colors';
import { type DiffPageSection, gitDiffFile, openInBrowser, writeDiffPage } from '../utils/diff';
import {
  createSpinner,
  filesWithStatus,
  findMaskingPins,
  findProtectedBehind,
  hyperlink,
  plural,
  spinnerSuccess,
} from '../utils/display';

/** Diffs on one page at most: each costs ~60 ms to render and ~85 KB of page. The rest are listed by path. */
const MAX_PAGE_FILES = 50;

/** Larger patches are listed instead of rendered: highlighting them stalls the run. */
const MAX_PATCH_BYTES = 512 * 1024;

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
 * fork's own changes to files that still sync. Empty sections are left out, and so is every
 * section when the engine could not resolve the sync range.
 */
export function reviewSections(result: MergeResult, command: 'analyze' | 'sync'): ReviewSection[] {
  const [base, upstream] = result.upstreamDiffRange?.split('..') ?? [];
  if (!base || !upstream) return [];
  const sinceSync = `${base}..${upstream}`;

  const dropped: ReviewSection =
    command === 'sync'
      ? {
          title: 'protected files kept the fork version',
          hint: 'What upstream changed in these files since the last sync. The fork kept its own version, so none of it arrived: adopt what you need.',
          range: sinceSync,
          paths: result.protectedConflicts ?? [],
        }
      : {
          title: 'protected but behind upstream',
          hint: 'What upstream changed in these files since the last sync. They are pinned or ignored, so the sync keeps the fork version and none of it arrives: adopt what you need.',
          range: sinceSync,
          paths: findProtectedBehind(result.files).map((file) => file.path),
        };

  const sections: ReviewSection[] = [
    dropped,
    {
      title: 'ignored paths changed upstream',
      hint: 'What upstream changed under ignored paths since the last sync. The fork left these files untouched, and ignored paths never sync.',
      range: sinceSync,
      paths: (result.ignoredUpstreamChanges ?? []).flatMap((group) => group.paths),
    },
    {
      title: 'pinned files that match the previous upstream',
      hint: 'What upstream changed in these files since the last sync. The fork copy still equals the previous upstream, so the pin only drops these changes: unpin to take them.',
      range: sinceSync,
      paths: findMaskingPins(result.files).map((file) => file.path),
    },
  ];

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

/**
 * Write the review page for `sections` and return its path with the number of diffs on it.
 * Files past the page limit, oversized patches and patches without a text hunk (binary, mode
 * only) are listed by path. Undefined when no file has a diff.
 */
export async function writeReviewPage(
  forkPath: string,
  sections: ReviewSection[],
  meta: { command: 'analyze' | 'sync'; range: string },
): Promise<{ path: string; diffs: number } | undefined> {
  const [base, upstream] = meta.range.split('..');
  let diffs = 0;
  const pageSections: DiffPageSection[] = [];

  for (const section of sections) {
    const pageSection: DiffPageSection = { title: section.title, hint: section.hint, files: [], omitted: [] };
    for (const path of section.paths) {
      if (diffs >= MAX_PAGE_FILES) {
        pageSection.omitted?.push(path);
        continue;
      }
      const patch = gitDiffFile(forkPath, section.range, path);
      if (patch.length === 0) continue;
      if (patch.length > MAX_PATCH_BYTES || !patch.includes('\n@@ ')) {
        pageSection.omitted?.push(path);
        continue;
      }
      pageSection.files.push({ path, patch: patch.toString() });
      diffs++;
    }
    if (pageSection.files.length > 0 || pageSection.omitted?.length) pageSections.push(pageSection);
  }

  if (diffs === 0) return undefined;
  const page = await writeDiffPage(
    pageSections,
    { title: `${meta.command} review`, note: `${basename(forkPath)} · last sync ${base} → upstream ${upstream}` },
    forkPath,
    `${meta.command}-review`,
  );
  return { path: page, diffs };
}

/**
 * After an analyze or sync report: write the review page and print where it is. Sync opens it in
 * the browser when stdout is a terminal, since the upstream changes it lists did not arrive.
 * Silent when there is nothing to review; a failure prints nothing and never fails the run.
 */
export async function reportReviewPage(
  forkPath: string,
  result: MergeResult,
  command: 'analyze' | 'sync',
): Promise<void> {
  const sections = reviewSections(result, command);
  if (sections.length === 0 || !result.upstreamDiffRange) return;

  createSpinner('writing review page...');
  let page: Awaited<ReturnType<typeof writeReviewPage>>;
  try {
    page = await writeReviewPage(forkPath, sections, { command, range: result.upstreamDiffRange });
  } catch {
    page = undefined;
  }
  spinnerSuccess();
  if (!page) return;

  const opened = command === 'sync' && process.stdout.isTTY === true && openInBrowser(page.path);
  console.info();
  console.info(
    `${pc.cyan('⧈')} review page with ${plural(page.diffs, 'diff')}${opened ? ', opened in the browser' : ''}:`,
  );
  console.info(pc.dim(`  ${hyperlink(page.path, pathToFileURL(page.path).href)}`));
}
