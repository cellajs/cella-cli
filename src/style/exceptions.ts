import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { warningMark } from '../utils/display';
import { detachedCommentRule } from './comment-rules';
import { docRules } from './doc-rules';
import { wordingRules } from './wording-rules';

/** What an app's `shared/config/style-exceptions.ts` exempts from `cella style`. */
export interface StyleExceptions {
  /** Repo-relative files and folders each rule skips, by rule id. */
  exempt: { [ruleId: string]: string[] };
  /** Class names kept as hooks with no Tailwind utility or stylesheet rule behind them. */
  markerClasses: string[];
}

/** Relative to the repo root; `shared/config` never merges, so the file is the app's to fill. */
const exceptionsPath = 'shared/config/style-exceptions.ts';
const allowlistPath = 'shared/config/vocabulary-allowlist.ts';

/** The exceptions of the template's own code, which every app inherits. */
export const templateExceptions: StyleExceptions = {
  exempt: {
    'source-control-term': [
      // release-please copies merged commit titles verbatim, so a title with the CLI's term must not fail the release PR
      'CHANGELOG.md',
      'cella/CHANGELOG.md',
      'cella/cella.config.ts',
      // The cella-upgrade skill documents the CLI's upgrade workflow and the app-side marker, both in the CLI's term; it
      // stays byte-identical with the apps' copies, so `pnpm cella upgrade` reports it as identical
      'cella/skills/cella-upgrade/SKILL.md',
      // Alignment READMEs address app maintainers pulling template changes, whom the CLI's term describes precisely
      'cella/alignments/',
    ],
    // The marketing site and the docs content are the template's own voice
    'product-name': ['frontend/src/modules/marketing/', 'frontend/src/content/'],
    // Agent-associated wording, skipped in cella/infra/ and in alignments, which address app maintainers
    'load-bearing': ['cella/alignments/', 'cella/infra/'],
    authoritative: ['cella/alignments/', 'cella/infra/'],
    'consequence-tail': ['cella/alignments/', 'backend/drizzle/'],
    // Alignments address an upgrade's maintainer once, skills address an agent
    'long-paragraph': ['cella/alignments/', 'cella/skills/'],
    // Palette grays that carry meaning the theme steps do not
    'text-color': [
      // Syntax, HTTP method and status colors
      'frontend/src/modules/docs/',
      // Syntax colors of the JSON viewer
      'frontend/src/modules/common/json-viewer/theme.ts',
      // Syntax colors of the code on the hero phone, an editor that stays dark in both modes
      'frontend/src/modules/marketing/about/hero-stack.tsx',
    ],
    // The editor's block handle moves blocks from its own menu
    'reorder-grip': ['frontend/src/modules/common/blocknote/custom-side-menu/side-menu.tsx'],
    // App-owned paths with nothing template code depends on: content, brand files and generated output. `shared/config`
    // is here too, because the config type already reports a key an app's config lacks.
    'owed-alignment': [
      'README.md',
      '.github/',
      'cella/a11y-ledger.json',
      'frontend/public/',
      'frontend/src/content',
      'frontend/src/routes/routeTree.gen.ts',
      'frontend/src/styling/gradients.css',
      'cella/infra/',
      'sdk/gen',
      'shared/config',
      'shared/json/',
      'shared/locales/',
    ],
  },
  // BoardPanel state for apps whose board selects items (hasSelection), a hook for their styles
  markerClasses: ['is-selected'],
};

const paths = z.array(z.string());
const exceptionsSchema = z.strictObject({
  exempt: z.record(z.string(), paths).default({}),
  markerClasses: paths.default([]),
});
/** `files` and `prefixes` may carry the source-control term, the prose rules skip `proseExclude`, and each marker class has its reason. */
const allowlistSchema = z.strictObject({
  files: paths.default([]),
  prefixes: paths.default([]),
  proseExclude: paths.default([]),
  markerClasses: z.record(z.string(), z.string()).default({}),
});

/** The 0.7 shape of the app's exceptions, in `shared/config/vocabulary-allowlist.ts`. */
export type VocabularyAllowlist = z.input<typeof allowlistSchema>;

/** The app's file, validated: the 0.7 file mapped with a warning when only that one exists, which goes at 1.0. */
async function appExceptions(root: string): Promise<StyleExceptions | undefined> {
  const read = async <T>(path: string, name: string, schema: z.ZodType<T>): Promise<T> => {
    const parsed = schema.safeParse((await import(pathToFileURL(join(root, path)).href))[name]);
    if (!parsed.success) throw new Error(`${path} exports no valid ${name}:\n${z.prettifyError(parsed.error)}`);
    return parsed.data;
  };
  if (existsSync(join(root, exceptionsPath))) return read(exceptionsPath, 'styleExceptions', exceptionsSchema);
  if (!existsSync(join(root, allowlistPath))) return undefined;
  console.warn(
    `${warningMark} ${allowlistPath} has the 0.7 shape, which the CLI reads until 1.0: move it to ${exceptionsPath} as \`styleExceptions: StyleExceptions\`.`,
  );
  const { files, prefixes, proseExclude, markerClasses } = await read(allowlistPath, 'vocabularyAllowlist', allowlistSchema);
  const proseRules = [...wordingRules, ...docRules, detachedCommentRule];
  return {
    exempt: {
      'source-control-term': [...files, ...prefixes],
      ...Object.fromEntries(proseRules.map(({ id }) => [id, proseExclude])),
    },
    markerClasses: Object.keys(markerClasses),
  };
}

/**
 * The template's exceptions merged with the app's.
 * @throws when the app's file is not the shape, or exempts from a rule id not in `ruleIds`
 */
export async function loadExceptions(root: string, ruleIds: string[]): Promise<StyleExceptions> {
  const app = await appExceptions(root);
  const unknown = Object.keys(app?.exempt ?? {}).filter((id) => !ruleIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(`${exceptionsPath} exempts from no rule named ${unknown.join(', ')}; the rules: ${ruleIds.join(', ')}`);
  }
  const ids = new Set([...Object.keys(templateExceptions.exempt), ...Object.keys(app?.exempt ?? {})]);
  return {
    exempt: Object.fromEntries([...ids].map((id) => [id, [...(templateExceptions.exempt[id] ?? []), ...(app?.exempt[id] ?? [])]])),
    markerClasses: [...templateExceptions.markerClasses, ...(app?.markerClasses ?? [])],
  };
}
