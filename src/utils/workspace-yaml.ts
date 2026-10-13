/**
 * Reads and edits the settings in `pnpm-workspace.yaml` that the audit service manages. Edits go
 * through a parsed document, so comments, quoting and every other setting stay as they are.
 */

import { type Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';

/** The audit-related settings of a `pnpm-workspace.yaml`. */
export interface AuditSettings {
  /** `overrides`: selector key to target range. */
  overrides: Record<string, string>;
  /** `minimumReleaseAgeExclude` entries: a package name, optionally with `@version`. */
  releaseAgeExcludes: string[];
  /** `auditConfig.ignoreGhsas`: advisory ids that `pnpm audit` leaves out. */
  ignoredGhsas: string[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(record(value)).map(([key, entry]) => [key, String(entry)]));

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/**
 * The audit settings in the file content; a missing or malformed block reads as empty. Throws on
 * content that is not valid YAML, which could not be written back either.
 */
export function readAuditSettings(content: string): AuditSettings {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
  const settings = record(doc.toJS());
  return {
    overrides: stringRecord(settings.overrides),
    releaseAgeExcludes: stringList(settings.minimumReleaseAgeExclude),
    ignoredGhsas: stringList(record(settings.auditConfig).ignoreGhsas),
  };
}

/** A top-level setting of the file as plain data, e.g. the `catalog` map; undefined when it is missing. */
export function readTopLevel(content: string, key: string): unknown {
  return record(parseDocument(content).toJS())[key];
}

/** Files that `patchedDependencies` points at, relative to the workspace root. */
export function readPatchFiles(content: string): string[] {
  return Object.values(stringRecord(record(parseDocument(content).toJS()).patchedDependencies));
}

const keyOf = (pair: { key: unknown }): string => String(isScalar(pair.key) ? pair.key.value : pair.key);

const itemText = (item: unknown): string => String(isScalar(item) ? item.value : item);

/** Runs `change` on a map; a map whose keys were sorted is sorted again afterwards, as pnpm keeps them. */
function keepingOrder(map: YAMLMap, change: () => void): void {
  const keys = map.items.map(keyOf);
  const wasSorted = keys.every((key, i) => i === 0 || keys[i - 1].localeCompare(key) <= 0);
  change();
  if (wasSorted) map.items.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/** The map at `path`, created (with its parents) when missing. */
function mapAt(doc: Document, path: string[]): YAMLMap {
  if (path.length === 0) {
    if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
    return doc.contents as YAMLMap;
  }
  const parent = mapAt(doc, path.slice(0, -1));
  const key = path[path.length - 1];
  const existing = parent.get(key, true);
  if (isMap(existing)) {
    // An empty `{}` would keep its entries on one line.
    if (existing.items.length === 0) existing.flow = false;
    return existing;
  }
  const created = doc.createNode({}) as YAMLMap;
  keepingOrder(parent, () => parent.set(key, created));
  return created;
}

/** Make the map at `path` hold exactly `entries`: untouched pairs keep their node, position and comments. */
function syncMap(doc: Document, path: string[], entries: Record<string, string>): void {
  if (!isMap(doc.getIn(path)) && Object.keys(entries).length === 0) return;

  const map = mapAt(doc, path);
  keepingOrder(map, () => {
    for (const key of map.items.map(keyOf)) if (!(key in entries)) map.delete(key);
    for (const [key, value] of Object.entries(entries)) map.set(key, value);
  });
  if (map.items.length === 0) doc.deleteIn(path);
}

/** Make the list at `path` hold exactly `entries`: kept items stay in place, new ones go last. */
function syncList(doc: Document, path: string[], entries: string[]): void {
  const current = doc.getIn(path);
  if (!isSeq(current)) {
    if (entries.length === 0) return;
    const parent = mapAt(doc, path.slice(0, -1));
    keepingOrder(parent, () => parent.set(path[path.length - 1], doc.createNode(entries)));
    return;
  }

  current.items = current.items.filter((item) => entries.includes(itemText(item)));
  const present = new Set(current.items.map(itemText));
  for (const entry of entries) if (!present.has(entry)) current.add(doc.createNode(entry));
  if (current.items.length === 0) doc.deleteIn(path);
  else current.flow = false;
}

/**
 * The file content with the audit settings replaced by `next`. A block that ends up empty is
 * removed, and so is an `auditConfig` left without keys.
 */
export function writeAuditSettings(content: string, next: AuditSettings): string {
  const doc = parseDocument(content);
  syncMap(doc, ['overrides'], next.overrides);
  syncList(doc, ['minimumReleaseAgeExclude'], next.releaseAgeExcludes);
  syncList(doc, ['auditConfig', 'ignoreGhsas'], next.ignoredGhsas);

  const auditConfig = doc.getIn(['auditConfig']);
  if (isMap(auditConfig) && auditConfig.items.length === 0) doc.deleteIn(['auditConfig']);

  return doc.toString({ lineWidth: 0, singleQuote: true });
}
