import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Marks the entries this runner wrote: an entry of another epoch (Artillery's has none) stays in the file and is never
 * compared. A new epoch starts when a measurement changes what it times.
 */
export const runnerEpoch = 'cella-bench@2';

interface EndpointBaseline {
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  nonOk: number;
  timeouts: number;
}

/** One passing full run. Latencies in milliseconds, `http.response_time` unless named otherwise. */
export interface BaselineEntry {
  runner: typeof runnerEpoch;
  timestamp: string;
  scenario: string;
  /** The emulated round trip in milliseconds; an entry without one ran at 0. */
  rttMs?: number;
  requests: number;
  requestRate: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  vusersCreated: number;
  vusersFailed: number;
  /** The latency the scenario chose to compare first, such as `yjs.peer_latency_ms.p95`. */
  primary: { metric: string; value: number };
  endpoints: Record<string, EndpointBaseline>;
}

interface Delta {
  label: string;
  current: number;
  baseline: number;
  /** Percent change; null when the baseline is zero. */
  pct: number | null;
  lowerIsBetter: boolean;
}

const isComparable = (entry: unknown): entry is BaselineEntry => (entry as { runner?: unknown } | null)?.runner === runnerEpoch;

function readEntries(file: string): unknown[] {
  if (!existsSync(file)) return [];
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [data];
  } catch {
    return [];
  }
}

export const baselineFile = (dir: string, scenario: string) => join(dir, 'baselines', `${scenario}.json`);

/** The newest entry of this runner epoch and round trip, with the count of older-epoch entries kept beside it. */
export function loadBaseline(dir: string, scenario: string, rttMs = 0): { baseline: BaselineEntry | null; older: number } {
  const entries = readEntries(baselineFile(dir, scenario));
  const comparable = entries.filter(isComparable);
  const baseline = comparable.findLast((entry) => (entry.rttMs ?? 0) === rttMs) ?? null;
  return { baseline, older: entries.length - comparable.length };
}

/**
 * Appends a run to the scenario's history.
 * @returns How many entries the history holds.
 */
export function saveBaseline(dir: string, entry: BaselineEntry): number {
  const file = baselineFile(dir, entry.scenario);
  const entries = readEntries(file);
  entries.push(entry);
  mkdirSync(join(dir, 'baselines'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  return entries.length;
}

/** The changes from `baseline` worth a glance: the primary latency first, then the HTTP percentiles and the rate. */
export function compareBaseline(current: BaselineEntry, baseline: BaselineEntry): Delta[] {
  const delta = (label: string, now: number, before: number, lowerIsBetter = true): Delta => ({
    label,
    current: now,
    baseline: before,
    pct: before === 0 ? null : ((now - before) / before) * 100,
    lowerIsBetter,
  });
  const deltas: Delta[] = [];
  if (current.primary.metric === baseline.primary.metric) deltas.push(delta(current.primary.metric, current.primary.value, baseline.primary.value));
  if (current.requests > 0) {
    if (current.primary.metric !== 'http.response_time.p50') deltas.push(delta('p50', current.p50, baseline.p50));
    if (current.primary.metric !== 'http.response_time.p95') deltas.push(delta('p95', current.p95, baseline.p95));
    deltas.push(delta('p99', current.p99, baseline.p99), delta('req/s', current.requestRate, baseline.requestRate, false));
  }
  return deltas;
}
