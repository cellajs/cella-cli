import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { movedPath } from '../../utils/app-facts';

/** Where an app keeps its translations, `<dir>/<language>/<file>.json`: `shared/locales`, or `locales` in an older app. */
export const localesDir = (forkPath: string): string => movedPath(forkPath, 'shared/locales', 'locales');
/** Runtime namespaces that merge several files, later files winning: `{ "c": ["common", "app"] }`. */
const MANIFEST = 'namespaces.json';
/** English holds every key; every other language is measured against it. */
export const SOURCE_LANGUAGE = 'en';

/** One `"key": "value"` line of a locale file, both tokens as written, escapes included. */
export interface RawEntry {
  key: string;
  value: string;
  /** The JSON-encoded key and value, written back unchanged. */
  raw: [key: string, value: string];
}

/** A flat locale file as `pnpm lint:fix` writes it: one entry per line, in file order. */
export interface LocaleFile {
  path: string;
  indent: string;
  entries: RawEntry[];
}

export interface Locales {
  /** The folder the files come from, relative to the app root. */
  dir: string;
  /** The source language first, the others sorted. */
  languages: string[];
  /** Each runtime namespace and the files it reads, in merge order. */
  namespaces: Map<string, string[]>;
  /** `<language>/<file>` to its file. */
  files: Map<string, LocaleFile>;
}

const entryPattern = /^(\s+)("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*"),?\s*$/;

/**
 * A locale file's entries, or a reason it cannot be edited in place: anything but a flat object of strings with one
 * entry per line.
 */
export function parseLocaleFile(path: string, text: string): LocaleFile | string {
  if (text.trim() === '{}') return { path, indent: '  ', entries: [] };
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines[0] !== '{' || lines.at(-1) !== '}') return 'not one JSON object with one entry per line';
  const entries: RawEntry[] = [];
  let indent = '  ';
  for (const line of lines.slice(1, -1)) {
    const match = entryPattern.exec(line);
    if (!match) return `cannot read the line ${JSON.stringify(line.trim())}`;
    indent = match[1];
    entries.push({ key: JSON.parse(match[2]), value: JSON.parse(match[3]), raw: [match[2], match[3]] });
  }
  return { path, indent, entries };
}

export function serializeLocaleFile(file: LocaleFile): string {
  if (file.entries.length === 0) return '{}\n';
  return `{\n${file.entries.map(({ raw }) => `${file.indent}${raw[0]}: ${raw[1]}`).join(',\n')}\n}\n`;
}

export function writeLocaleFile(forkPath: string, file: LocaleFile): void {
  writeFileSync(join(forkPath, file.path), serializeLocaleFile(file));
}

/** A file's texts by key; a later duplicate wins, as `JSON.parse` does. */
export const textsOf = (file: LocaleFile | undefined): Record<string, string> =>
  Object.fromEntries((file?.entries ?? []).map(({ key, value }) => [key, value]));

const readJsonObject = (path: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return Object.fromEntries(Object.entries(parsed));
};

/**
 * Every locale file of the app, and its runtime namespaces from `namespaces.json` in the locales folder.
 * @throws when the app has no `en/` or no manifest in that folder, or a locale file is not flat
 */
export function readLocales(forkPath: string): Locales {
  const localesPath = localesDir(forkPath);
  const dir = join(forkPath, localesPath);
  if (!existsSync(join(dir, SOURCE_LANGUAGE))) throw new Error(`no ${localesPath}/${SOURCE_LANGUAGE}/ in ${forkPath}`);

  const languages = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => (a === SOURCE_LANGUAGE ? -1 : b === SOURCE_LANGUAGE ? 1 : a.localeCompare(b)));

  const files = new Map<string, LocaleFile>();
  for (const language of languages) {
    for (const name of readdirSync(join(dir, language)).filter((name) => name.endsWith('.json'))) {
      const path = `${localesPath}/${language}/${name}`;
      const parsed = parseLocaleFile(path, readFileSync(join(forkPath, path), 'utf8'));
      if (typeof parsed === 'string') throw new Error(`${path}: ${parsed}; pnpm lint:fix writes one entry per line`);
      files.set(`${language}/${name.slice(0, -'.json'.length)}`, parsed);
    }
  }

  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`no ${localesPath}/${MANIFEST}: upgrade the app from cella first`);
  const merged = readJsonObject(manifestPath);
  const namespaces = new Map<string, string[]>();
  for (const [namespace, sources] of Object.entries(merged)) {
    if (!Array.isArray(sources) || !sources.every((source) => typeof source === 'string')) {
      throw new Error(`${localesPath}/${MANIFEST}: ${namespace} must list file names`);
    }
    namespaces.set(namespace, sources);
  }
  const mergedFiles = new Set([...namespaces.values()].flat());
  const ownFiles = [...new Set([...files.keys()].map((key) => key.split('/')[1]))].filter(
    (file) => !mergedFiles.has(file),
  );
  for (const file of ownFiles.sort()) namespaces.set(file, [file]);

  return { dir: localesPath, languages, namespaces, files };
}

/** A runtime namespace's texts in one language, merged as the app loads them. */
export function namespaceTexts(locales: Locales, language: string, namespace: string): Record<string, string> {
  const sources = locales.namespaces.get(namespace) ?? [];
  return Object.assign({}, ...sources.map((file) => textsOf(locales.files.get(`${language}/${file}`))));
}

/** The 1-based line of a key in a file, for a link into it. */
export const lineOf = (file: LocaleFile, key: string): number =>
  file.entries.findIndex((entry) => entry.key === key) + 2;

const pluralSuffix = /_(ordinal_)?(zero|one|two|few|many|other)$/;

/** A plural form's base key and category: `member_other` is `member` for `other`; any other key has none. */
export function pluralForm(key: string): { base: string; category: string; ordinal: boolean } | undefined {
  const match = pluralSuffix.exec(key);
  if (!match) return undefined;
  return { base: key.slice(0, match.index), category: match[2], ordinal: !!match[1] };
}

/** A key with every plural form i18next may look it up by. */
export const withPluralForms = (key: string): string[] => [
  key,
  ...['zero', 'one', 'two', 'few', 'many', 'other'].flatMap((category) => [
    `${key}_${category}`,
    `${key}_ordinal_${category}`,
  ]),
];
