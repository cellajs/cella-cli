import pc from '../../utils/colors';
import { checkMark, warningMark, writeStdout } from '../../utils/display';
import {
  LOCALES_DIR,
  type Locales,
  namespaceTexts,
  pluralForm,
  readLocales,
  SOURCE_LANGUAGE,
  textsOf,
} from './locales';
import {
  compare,
  englishFor,
  isPluralOf,
  type Mismatch,
  type PluralGap,
  placeholdersOf,
  pluralGaps,
  tagsOf,
} from './parity';

/** One runtime namespace in one language, measured against English. */
interface LanguageStatus {
  /** English keys this language translates. */
  translated: number;
  missing: string[];
  /** Keys English lacks. */
  orphans: string[];
  sameAsEnglish: string[];
  placeholders: Mismatch[];
  tags: Mismatch[];
  plurals: PluralGap[];
}

interface NamespaceStatus {
  name: string;
  files: string[];
  keys: number;
  /** English plural groups that lack or add a form. */
  plurals: PluralGap[];
  /** Per language, the keys a later file of the namespace redefines: `app.json` over `common.json`. */
  overrides: Record<string, { key: string; files: string[] }[]>;
  /** Every language but English. */
  languages: Record<string, LanguageStatus>;
}

export interface StatusReport {
  languages: string[];
  namespaces: NamespaceStatus[];
}

/** A key's text with at least one letter, so `{{count}}` or `·` equal to English is no finding. */
const hasWords = (text: string) => /\p{L}/u.test(text);

function overridesOf(locales: Locales, language: string, files: string[]): { key: string; files: string[] }[] {
  const definedIn = new Map<string, string[]>();
  for (const file of files) {
    for (const key of Object.keys(textsOf(locales.files.get(`${language}/${file}`)))) {
      definedIn.set(key, [...(definedIn.get(key) ?? []), file]);
    }
  }
  return [...definedIn].filter(([, inFiles]) => inFiles.length > 1).map(([key, inFiles]) => ({ key, files: inFiles }));
}

function measure(english: Record<string, string>, texts: Record<string, string>, language: string): LanguageStatus {
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  // A plural form for a category this language never uses is no missing key: the plural gaps report it
  const expected = Object.keys(english).filter((key) => {
    const form = pluralForm(key);
    return (
      !form || form.ordinal || !isPluralOf(english, key) || categories.some((category) => category === form.category)
    );
  });
  const status: LanguageStatus = {
    translated: expected.filter((key) => key in texts).length,
    missing: expected.filter((key) => !(key in texts)),
    orphans: Object.keys(texts).filter((key) => !(key in english) && !isPluralOf(english, key)),
    sameAsEnglish: [],
    placeholders: [],
    tags: [],
    plurals: pluralGaps(english, texts, language),
  };
  for (const [key, text] of Object.entries(texts)) {
    const source = englishFor(english, key);
    if (source === undefined) continue;
    if (text === source && key in english && hasWords(text)) status.sameAsEnglish.push(key);
    const placeholders = compare(key, source, text, placeholdersOf);
    if (placeholders) status.placeholders.push(placeholders);
    const tags = compare(key, source, text, tagsOf);
    if (tags) status.tags.push(tags);
  }
  return status;
}

export function buildStatus(locales: Locales): StatusReport {
  const others = locales.languages.filter((language) => language !== SOURCE_LANGUAGE);
  const namespaces = [...locales.namespaces].map(([name, files]): NamespaceStatus => {
    const english = namespaceTexts(locales, SOURCE_LANGUAGE, name);
    const languages = Object.fromEntries(
      others.map((language) => [language, measure(english, namespaceTexts(locales, language, name), language)]),
    );
    const overrides = Object.fromEntries(
      files.length > 1 ? locales.languages.map((language) => [language, overridesOf(locales, language, files)]) : [],
    );
    const plurals = pluralGaps(english, english, SOURCE_LANGUAGE);
    return { name, files, keys: Object.keys(english).length, plurals, overrides, languages };
  });
  return { languages: locales.languages, namespaces };
}

/** The findings that fail the status: a text that renders wrong, not one that is not translated yet. */
export const defectCount = (report: StatusReport): number =>
  report.namespaces.reduce(
    (sum, namespace) =>
      Object.values(namespace.languages).reduce(
        (count, status) =>
          count + status.orphans.length + status.placeholders.length + status.tags.length + status.plurals.length,
        sum + namespace.plurals.length,
      ),
    0,
  );

const LIST_MAX = 8;
const percent = (part: number, whole: number) => (whole === 0 ? 100 : Math.floor((part / whole) * 100));

type Cell = string | [text: string, style: (text: string) => string];
const columns: [title: string, width: number][] = [
  ['namespace', 11],
  ['lang', 6],
  ['keys', 6],
  ['translated', 12],
  ['orphans', 9],
  ['same', 6],
  ['placeholders', 14],
  ['tags', 6],
  ['plurals', 0],
];
/** A table row; a styled cell is padded before it is styled, so color codes never shift a column. */
const row = (cells: Cell[]) =>
  `  ${cells
    .map((cell, index) => {
      const [text, style] = typeof cell === 'string' ? [cell, (value: string) => value] : cell;
      return style(text.padEnd(columns[index][1]));
    })
    .join('')}`.trimEnd();
const findings = (count: number): Cell => (count === 0 ? ['✓', pc.green] : [String(count), pc.yellow]);

function printList(title: string, items: string[]): void {
  if (items.length === 0) return;
  const more = items.length > LIST_MAX ? `, … ${items.length - LIST_MAX} more (--json lists them)` : '';
  console.info(`  ${warningMark} ${title}`);
  console.info(`    ${pc.dim(`${items.slice(0, LIST_MAX).join(', ')}${more}`)}`);
}

const describe = ({ key, missing, extra }: Mismatch | PluralGap) =>
  [key, ...missing.map((name) => `-${name}`), ...extra.map((name) => `+${name}`)].join(' ');

function printStatus(report: StatusReport): void {
  const label = ({ name, files }: NamespaceStatus) =>
    files.length > 1 || files[0] !== name ? `${name} (${files.join(' + ')})` : name;
  console.info(
    `${pc.bold(`${LOCALES_DIR}/`)} ${pc.dim(`${report.languages.join(', ')} · namespaces ${report.namespaces.map(label).join(', ')}`)}`,
  );
  console.info();
  console.info(pc.dim(row(columns.map(([title]) => title))));
  for (const namespace of report.namespaces) {
    console.info(
      row([
        namespace.name,
        SOURCE_LANGUAGE,
        String(namespace.keys),
        '',
        '',
        '',
        '',
        '',
        findings(namespace.plurals.length),
      ]),
    );
    for (const [language, status] of Object.entries(namespace.languages)) {
      const expected = status.translated + status.missing.length;
      console.info(
        row([
          '',
          language,
          '',
          `${String(status.translated).padEnd(5)}${percent(status.translated, expected)}%`,
          findings(status.orphans.length),
          [String(status.sameAsEnglish.length), pc.dim],
          findings(status.placeholders.length),
          findings(status.tags.length),
          findings(status.plurals.length),
        ]),
      );
    }
  }
  console.info();

  for (const namespace of report.namespaces) {
    printList(
      `${namespace.name} ${SOURCE_LANGUAGE}: plural groups that lack or add a form`,
      namespace.plurals.map(describe),
    );
    for (const [language, status] of Object.entries(namespace.languages)) {
      const where = `${namespace.name} ${language}`;
      printList(`${where}: keys English lacks`, status.orphans);
      printList(`${where}: placeholders that differ from English`, status.placeholders.map(describe));
      printList(`${where}: tags that differ from English`, status.tags.map(describe));
      printList(`${where}: plural groups that lack or add a form`, status.plurals.map(describe));
    }
    const [first, ...later] = namespace.files;
    for (const [language, overrides] of Object.entries(namespace.overrides)) {
      printList(
        `${language}/${later.join(', ')} overrides ${overrides.length} keys of ${language}/${first}`,
        overrides.map(({ key }) => key),
      );
    }
  }

  const defects = defectCount(report);
  console.info(
    defects === 0
      ? `${checkMark} no orphans, placeholder, tag or plural mismatches`
      : `${pc.red('✗')} ${defects} findings above`,
  );
  for (const language of report.languages.filter((language) => language !== SOURCE_LANGUAGE)) {
    const statuses = report.namespaces.map((namespace) => namespace.languages[language]).filter((status) => !!status);
    const translated = statuses.reduce((sum, status) => sum + status.translated, 0);
    const expected = statuses.reduce((sum, status) => sum + status.translated + status.missing.length, 0);
    const same = statuses.reduce((sum, status) => sum + status.sameAsEnglish.length, 0);
    console.info(
      `  ${pc.dim(`${language} translates ${translated} of ${expected} keys (${percent(translated, expected)}%), ${same} the same as English`)}`,
    );
  }
  console.info(`  ${pc.dim('missing and same-as-English keys: --json lists them · cella i18n unused')}`);
}

/** `cella i18n`: per runtime namespace and language, what is missing, orphaned or mismatched. Exit 1 on a mismatch. */
export function runStatus(forkPath: string, json: boolean): number {
  const report = buildStatus(readLocales(forkPath));
  if (json) writeStdout(JSON.stringify(report, null, 2));
  else printStatus(report);
  return defectCount(report) === 0 ? 0 : 1;
}
