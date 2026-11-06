import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from '../../utils/colors';
import { checkMark, plural, warningMark, writeStdout } from '../../utils/display';
import { type LocaleFile, type Locales, type RawEntry, readLocales, withPluralForms, writeLocaleFile } from './locales';
import { escapeRegExp, isOpenPattern, listCodeFiles, loadTypeScript, patternTest, scanCode } from './scan';

export interface RenameOptions {
  from: string;
  to: string;
}

interface RenameReport {
  from: string;
  to: string;
  localeFiles: string[];
  codeFiles: { file: string; literals: number }[];
  /** Places the rename cannot rewrite: a literal without its namespace, a template whose types build the old key. */
  check: { file: string; line: number; source: string }[];
  /** Whether the app's Biome sorted the locale files it changed. */
  sorted: boolean;
}

/** `c:accept` as its namespace and key. */
export function parseKey(value: string, locales: Locales): { namespace: string; key: string } {
  const colon = value.indexOf(':');
  const namespace = value.slice(0, colon);
  const key = value.slice(colon + 1);
  if (colon < 1 || !key) throw new Error(`'${value}' is no key: write it as ns:key, such as c:accept`);
  if (!locales.namespaces.has(namespace)) {
    throw new Error(`no namespace '${namespace}': expected one of ${[...locales.namespaces.keys()].join(', ')}`);
  }
  return { namespace, key };
}

/**
 * Renames a key and its plural forms in every language, keeping each entry where it stands, or moves it into a
 * namespace that reads one file.
 * @returns the locale files it changed
 * @throws when the old key is in no file, or the new one already exists
 */
function renameInLocales(
  forkPath: string,
  locales: Locales,
  from: { namespace: string; key: string },
  to: { namespace: string; key: string },
): string[] {
  const targetFiles = locales.namespaces.get(to.namespace) ?? [];
  if (from.namespace !== to.namespace && targetFiles.length > 1) {
    throw new Error(
      `${to.namespace} reads ${targetFiles.join(' and ')}: move a key into it by hand, into the file it belongs to`,
    );
  }
  const fromForms = new Set(withPluralForms(from.key));
  const renamed = (entry: RawEntry): RawEntry => {
    const key = `${to.key}${entry.key.slice(from.key.length)}`;
    return { ...entry, key, raw: [JSON.stringify(key), entry.raw[1]] };
  };

  const changed = new Map<string, LocaleFile>();
  for (const language of locales.languages) {
    const filesOf = (namespace: string) =>
      (locales.namespaces.get(namespace) ?? []).flatMap((name) => locales.files.get(`${language}/${name}`) ?? []);
    for (const file of filesOf(to.namespace)) {
      const taken = file.entries.find((entry) => withPluralForms(to.key).includes(entry.key));
      if (taken) throw new Error(`${to.namespace}:${taken.key} already exists in ${file.path}`);
    }
    for (const file of filesOf(from.namespace)) {
      if (!file.entries.some((entry) => fromForms.has(entry.key))) continue;
      changed.set(file.path, file);
      if (from.namespace === to.namespace) {
        file.entries = file.entries.map((entry) => (fromForms.has(entry.key) ? renamed(entry) : entry));
        continue;
      }
      const target = locales.files.get(`${language}/${targetFiles[0]}`);
      if (!target)
        throw new Error(`${language} has no ${targetFiles[0]}.json to move ${from.namespace}:${from.key} into`);
      target.entries.push(...file.entries.filter((entry) => fromForms.has(entry.key)).map(renamed));
      file.entries = file.entries.filter((entry) => !fromForms.has(entry.key));
      changed.set(target.path, target);
    }
  }
  if (changed.size === 0) throw new Error(`${from.namespace}:${from.key} is in no locale file`);
  for (const file of changed.values()) writeLocaleFile(forkPath, file);
  return [...changed.keys()];
}

/** Rewrites every `'ns:old'` literal, plural forms included, in the app's code. */
function renameInCode(forkPath: string, from: string, to: string): { file: string; literals: number }[] {
  const literal = new RegExp(
    `(['"\`])${escapeRegExp(from)}((?:_(?:ordinal_)?(?:zero|one|two|few|many|other))?)(?=\\1)`,
    'g',
  );
  const changed: { file: string; literals: number }[] = [];
  for (const file of listCodeFiles(forkPath)) {
    const path = join(forkPath, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes(from)) continue;
    let literals = 0;
    const next = text.replace(literal, (_match, quote: string, suffix: string) => {
      literals++;
      return `${quote}${to}${suffix}`;
    });
    if (literals === 0) continue;
    writeFileSync(path, next);
    changed.push({ file, literals });
  }
  return changed;
}

/** Sorts the changed locale files with the app's own Biome, whose config decides the key order. */
function sortWithBiome(forkPath: string, files: string[]): boolean {
  const biome = join(forkPath, 'node_modules/.bin/biome');
  if (!existsSync(biome) || files.length === 0) return false;
  return spawnSync(biome, ['check', '--write', ...files], { cwd: forkPath, stdio: 'ignore' }).status === 0;
}

export async function rename(forkPath: string, options: RenameOptions): Promise<RenameReport> {
  const locales = readLocales(forkPath);
  const from = parseKey(options.from, locales);
  const to = parseKey(options.to, locales);
  if (options.from === options.to) throw new Error('the new name is the old one');

  const localeFiles = renameInLocales(forkPath, locales, from, to);
  const codeFiles = renameInCode(forkPath, options.from, options.to);
  const sorted = sortWithBiome(forkPath, localeFiles);

  // What no literal rewrite reaches: a key without its namespace in `t()`, a template that builds the old key. An
  // error type is typed, so the typecheck finds it
  const ts = await loadTypeScript(forkPath);
  const scan = scanCode(ts, forkPath, '', [...locales.namespaces.keys()], new Set([from.key]));
  const check = [
    ...(scan.bare.get(from.key) ?? [])
      .filter((site) => site.keyArgument)
      .map(({ file, line }) => ({ file, line, source: `'${from.key}'` })),
    ...scan.dynamic
      .filter((site) => {
        const target = site.namespace ? options.from : from.key;
        if (site.namespace && site.namespace !== from.namespace) return false;
        return site.keys
          ? site.keys.includes(target)
          : !isOpenPattern(site.pattern) && patternTest(site.pattern)(target);
      })
      .map(({ file, line, source }) => ({ file, line, source: `\`${source}\`` })),
  ];
  return { from: options.from, to: options.to, localeFiles, codeFiles, check, sorted };
}

/** `cella i18n rename <ns:old> <ns:new>`: the key in every locale file and in the code. */
export async function runRename(forkPath: string, options: RenameOptions, json: boolean): Promise<number> {
  const report = await rename(forkPath, options);
  if (json) {
    writeStdout(JSON.stringify(report, null, 2));
    return 0;
  }
  console.info(`${checkMark} renamed ${report.from} to ${pc.bold(report.to)}`);
  console.info(
    `  ${pc.dim(`${report.localeFiles.join(', ')}${report.sorted ? ' · sorted by biome' : ' · pnpm lint:fix sorts the keys'}`)}`,
  );
  const literals = report.codeFiles.reduce((sum, file) => sum + file.literals, 0);
  console.info(`  ${pc.dim(`code: ${plural(literals, 'literal')} in ${plural(report.codeFiles.length, 'file')}`)}`);
  for (const { file, literals: count } of report.codeFiles) console.info(`    ${pc.dim(`${file} ${count}`)}`);
  if (report.check.length > 0) {
    console.info(`${warningMark} ${plural(report.check.length, 'place')} may still name ${report.from}: check by hand`);
    for (const { file, line, source } of report.check) console.info(`  ${pc.dim(`${file}:${line}`)}  ${source}`);
  }
  return 0;
}
