import { pluralForm } from './locales';

/** What a translation adds or drops against the English text: interpolations, nested keys or tags. */
export interface Mismatch {
  key: string;
  missing: string[];
  extra: string[];
}

/**
 * Interpolation names and nested `$t()` keys, each once: `{{resource, lowercase}}` is `resource`, `{{- name}}` is
 * `name`. A translation may use a value once where English repeats it.
 */
export function placeholdersOf(text: string): string[] {
  const names = [...text.matchAll(/\{\{-?\s*([^,}\s]+)[^}]*\}\}/g)].map((match) => match[1]);
  const nested = [...text.matchAll(/\$t\(\s*([^,)\s]+)/g)].map((match) => `$t(${match[1]})`);
  return [...new Set([...names, ...nested])];
}

/** Opening and self-closing tags, by name and count: `<strong>a</strong> <br/>` is `br`, `strong`. */
export function tagsOf(text: string): string[] {
  return [...text.matchAll(/<([A-Za-z0-9]+)(?:\s[^<>]*)?\/?>/g)].map((match) => match[1]).sort();
}

/** The elements of `a` that `b` lacks, as a multiset: `[x, x]` against `[x]` lacks one `x`. */
function without(a: string[], b: string[]): string[] {
  const left = [...b];
  return a.filter((item) => {
    const index = left.indexOf(item);
    if (index === -1) return true;
    left.splice(index, 1);
    return false;
  });
}

/** How a translation's placeholders or tags differ from the English text; undefined when they match. */
export function compare(
  key: string,
  english: string,
  translation: string,
  extract: (text: string) => string[],
): Mismatch | undefined {
  const expected = extract(english);
  const actual = extract(translation);
  const missing = [...new Set(without(expected, actual))];
  const extra = [...new Set(without(actual, expected))];
  return missing.length + extra.length > 0 ? { key, missing, extra } : undefined;
}

/** A plural group of one language that lacks a form the language needs, or has one it never uses. */
export interface PluralGap {
  key: string;
  missing: string[];
  extra: string[];
}

const categoriesOf = (language: string, ordinal: boolean): string[] => {
  try {
    return new Intl.PluralRules(language, { type: ordinal ? 'ordinal' : 'cardinal' }).resolvedOptions()
      .pluralCategories;
  } catch {
    return ['one', 'other'];
  }
};

const groupKey = (base: string, ordinal: boolean) => `${base}${ordinal ? '_ordinal' : ''}`;

/**
 * The plural groups of the English texts, by base (`_ordinal` appended for ordinals). A group holds the `_other` form
 * and the base or another form: `send_one` beside no `send_other` is a plain key, and so is an `_other` key called by
 * its full name with nothing beside it.
 */
const groupsCache = new WeakMap<Record<string, string>, Map<string, { base: string; ordinal: boolean }>>();

function pluralGroups(english: Record<string, string>): Map<string, { base: string; ordinal: boolean }> {
  const cached = groupsCache.get(english);
  if (cached) return cached;
  const forms = new Map<string, { base: string; ordinal: boolean; count: number }>();
  for (const key of Object.keys(english)) {
    const form = pluralForm(key);
    if (!form) continue;
    const group = forms.get(groupKey(form.base, form.ordinal)) ?? { base: form.base, ordinal: form.ordinal, count: 0 };
    group.count++;
    forms.set(groupKey(form.base, form.ordinal), group);
  }
  const groups = new Map(
    [...forms]
      .filter(
        ([key, { base, ordinal, count }]) => `${key}_other` in english && (count > 1 || (!ordinal && base in english)),
      )
      .map(([key, { base, ordinal }]) => [key, { base, ordinal }]),
  );
  groupsCache.set(english, groups);
  return groups;
}

/**
 * The plural groups of `texts` in `language` that are incomplete: each category the language uses needs its form or
 * the base key, which i18next falls back to; a form for a category the language never uses is extra.
 */
export function pluralGaps(
  english: Record<string, string>,
  texts: Record<string, string>,
  language: string,
): PluralGap[] {
  const groups = pluralGroups(english);
  const present = new Map<string, Set<string>>();
  for (const key of Object.keys(texts)) {
    const form = pluralForm(key);
    const group = form && groupKey(form.base, form.ordinal);
    if (form && group && groups.has(group)) present.set(group, (present.get(group) ?? new Set()).add(form.category));
    else if (groups.has(key)) present.set(key, present.get(key) ?? new Set());
  }

  const gaps: PluralGap[] = [];
  // A group the language has not started falls back to English as a whole: that is a missing key, no gap
  for (const [key, categoriesPresent] of present) {
    const { base, ordinal } = groups.get(key) ?? { base: key, ordinal: false };
    const categories = categoriesOf(language, ordinal);
    const missing = categories.filter((category) => !categoriesPresent.has(category) && !(base in texts));
    const extra = [...categoriesPresent].filter((category) => !categories.includes(category));
    if (missing.length + extra.length > 0) gaps.push({ key, missing, extra });
  }
  return gaps;
}

/** Whether `key` of a language is a plural form of an English group, so no orphan even when English lacks it. */
export function isPluralOf(english: Record<string, string>, key: string): boolean {
  const form = pluralForm(key);
  return !!form && pluralGroups(english).has(groupKey(form.base, form.ordinal));
}

/** The English text a translated key answers to: its own, or for a plural form English lacks, the `_other` form. */
export function englishFor(english: Record<string, string>, key: string): string | undefined {
  if (key in english) return english[key];
  const form = pluralForm(key);
  return form ? english[`${groupKey(form.base, form.ordinal)}_other`] : undefined;
}
