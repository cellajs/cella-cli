import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import pc from '../../utils/colors';
import { padVisible } from '../../utils/layout';
import { type BaselineEntry, compareBaseline, RUNNER_EPOCH } from './baseline';
import type { Distribution } from './metrics';
import type { RunSummary } from './run';

/** Where a run prints: stdout, or a stand-in with the same three members. */
export interface Output {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

const visible = (text: string) => stripVTControlCharacters(text).length;

export const count = (n: number) => Math.round(n).toLocaleString('en-US');

/** Milliseconds, one decimal below 10. */
export const ms = (n: number) => (n < 10 ? `${n.toFixed(1)}ms` : `${Math.round(n)}ms`);

const seconds = (n: number) => `${Math.round(n)}s`;

/**
 * The live block at the bottom of the output. On a terminal each render replaces the previous block and `log` prints
 * above it; piped output gets every render appended, so a log file holds the whole run.
 */
export class LiveDisplay {
  private rows = 0;
  private lines: string[] = [];

  constructor(
    private readonly tty: boolean,
    private readonly out: Output = process.stdout,
  ) {}

  render(lines: string[]): void {
    this.lines = lines;
    if (!this.tty) {
      for (const line of lines) this.out.write(`${line}\n`);
      return;
    }
    this.clear();
    this.draw();
  }

  log(text: string): void {
    if (!this.tty) {
      this.out.write(`${text}\n`);
      return;
    }
    this.clear();
    this.out.write(`${text}\n`);
    this.draw();
  }

  /** Removes the block from a terminal; piped output keeps what it printed. */
  clear(): void {
    if (this.rows > 0) this.out.write(`\x1b[${this.rows}F\x1b[J`);
    this.rows = 0;
  }

  private draw(): void {
    const columns = this.out.columns || 80;
    for (const line of this.lines) this.out.write(`${line}\n`);
    this.rows = this.lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(visible(line) / columns)), 0);
  }
}

export interface LiveState {
  scenario: string;
  phase: string;
  elapsedS: number;
  /** Seconds the phases take; null for a single-run scenario. */
  plannedS: number | null;
  vus: { started: number; active: number; completed: number; failed: number };
  intervalS: number;
  counters: Record<string, number>;
  http?: Distribution;
  primary?: { name: string; distribution: Distribution };
  /** Interval deltas of the scenario's own counters. */
  custom: [string, number][];
  lagP99: number;
}

export function liveLines(state: LiveState): string[] {
  const { vus, counters } = state;
  const time =
    state.plannedS === null ? seconds(state.elapsedS) : `${seconds(state.elapsedS)}/${seconds(state.plannedS)}`;
  const head = `${pc.bold(state.scenario)} ${pc.dim(`· ${state.phase} · ${time}`)}`;

  const parts = [
    `vus +${count(vus.started)} ▸${count(vus.active)} ✓${count(vus.completed)} ${vus.failed > 0 ? pc.red(`✗${count(vus.failed)}`) : '✗0'}`,
  ];
  const requests = counters['http.requests'] ?? 0;
  if (requests > 0 || state.http) {
    parts.push(`${count(requests / state.intervalS)} req/s`);
    if (state.http) parts.push(`p50 ${ms(state.http.p50)} p95 ${ms(state.http.p95)} p99 ${ms(state.http.p99)}`);
    const classes = new Map<string, number>();
    for (const [name, n] of Object.entries(counters)) {
      const status = /^http\.codes\.(\d)\d\d$/.exec(name)?.[1];
      if (status) classes.set(`${status}xx`, (classes.get(`${status}xx`) ?? 0) + n);
    }
    const codes = [...classes]
      .sort()
      .map(([cls, n]) => (cls === '2xx' ? `${cls} ${count(n)}` : pc.yellow(`${cls} ${count(n)}`)));
    if (codes.length) parts.push(codes.join(' '));
  }
  const errors = Object.entries(counters).filter(([name]) => name.startsWith('errors.'));
  if (errors.length) parts.push(pc.red(errors.map(([name, n]) => `${name.slice(7)} ${count(n)}`).join(' ')));
  if (state.primary) {
    const d = state.primary.distribution;
    parts.push(`${state.primary.name} p50 ${ms(d.p50)} p95 ${ms(d.p95)}`);
  }
  for (const [name, n] of state.custom) parts.push(`${name} +${count(n)}`);
  parts.push(pc.dim(`gen lag ${ms(state.lagP99)}`));
  return [head, `  ${parts.join(pc.dim(' · '))}`];
}

/** The run's summary as the report prints it: the scenario's own counters, and the baseline it was compared with. */
export interface SummaryView
  extends Omit<RunSummary, 'type' | 'runner' | 'startedAt' | 'counters' | 'generatorLagP99MaxMs' | 'attachments'> {
  counters: [string, number][];
  /** False for a short or failed run: neither is compared. */
  compared: boolean;
  baseline: BaselineEntry | null;
  olderBaselines: number;
  current: BaselineEntry;
  saved: number | null;
  logFile: string;
  lagWarning: string | null;
}

const pad = (text: string, width: number, left = false) => (left ? text.padEnd(width) : text.padStart(width));

function deltaText(pct: number | null, lowerIsBetter: boolean): string {
  if (pct === null) return pc.dim('n/a');
  if (Math.abs(pct) < 1) return pc.dim('~0%');
  const label = `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%`;
  return (lowerIsBetter ? pct < 0 : pct > 0) ? pc.green(label) : pc.red(label);
}

/** The end-of-run report: per-endpoint table, custom histograms and counters, checks, baseline delta and log path. */
export function summaryLines(view: SummaryView): string[] {
  const lines: string[] = [];
  const vus = `${count(view.vus.created)} VUs (✓${count(view.vus.completed)} ✗${count(view.vus.failed)})`;
  const reqs = view.requests > 0 ? ` · ${count(view.requests)} requests · ${count(view.requestRate)} req/s` : '';
  lines.push(
    `${pc.bold(view.scenario)}${view.short ? pc.dim(' (short)') : ''} · ${view.durationS.toFixed(1)} s · ${vus}${reqs}`,
  );

  const labels = Object.keys(view.endpoints);
  if (labels.length) {
    const width = Math.max(8, ...labels.map((label) => label.length));
    lines.push(
      pc.dim(
        `  ${pad('endpoint', width, true)} ${pad('req', 8)} ${pad('p50', 8)} ${pad('p95', 8)} ${pad('p99', 8)} ${pad('max', 8)} ${pad('non-2xx', 8)} ${pad('timeouts', 9)}`,
      ),
    );
    for (const [label, e] of Object.entries(view.endpoints)) {
      const d = e.ttfb;
      const nonOk = e.nonOk > 0 ? pc.yellow(pad(count(e.nonOk), 8)) : pad('0', 8);
      const timeouts = e.timeouts > 0 ? pc.red(pad(count(e.timeouts), 9)) : pad('0', 9);
      lines.push(
        `  ${pad(label, width, true)} ${pad(count(e.requests), 8)} ${pad(ms(d.p50), 8)} ${pad(ms(d.p95), 8)} ${pad(ms(d.p99), 8)} ${pad(ms(d.max), 8)} ${nonOk} ${timeouts}`,
      );
      const rejected = Object.entries(e.codes).filter(([code]) => !code.startsWith('2'));
      if (rejected.length)
        lines.push(pc.dim(`  ${' '.repeat(width)} ${rejected.map(([code, n]) => `${code} ×${count(n)}`).join(', ')}`));
    }
  }

  const histograms = Object.entries(view.histograms);
  if (histograms.length) {
    const width = Math.max(9, ...histograms.map(([name]) => name.length));
    lines.push(
      pc.dim(
        `  ${pad('histogram', width, true)} ${pad('count', 8)} ${pad('p50', 8)} ${pad('p95', 8)} ${pad('p99', 8)} ${pad('max', 8)}`,
      ),
    );
    for (const [name, d] of histograms) {
      lines.push(
        `  ${pad(name, width, true)} ${pad(count(d.count), 8)} ${pad(ms(d.p50), 8)} ${pad(ms(d.p95), 8)} ${pad(ms(d.p99), 8)} ${pad(ms(d.max), 8)}`,
      );
    }
  }

  if (view.counters.length)
    lines.push(`  ${view.counters.map(([name, n]) => `${name} ${pc.bold(count(n))}`).join(pc.dim(' · '))}`);
  for (const [code, { count: n, message }] of Object.entries(view.errors)) {
    lines.push(pc.red(`  errors.${code} ${count(n)}${message ? `: ${message}` : ''}`));
  }
  if (view.lagWarning) lines.push(pc.yellow(`  ⚠ ${view.lagWarning}`));

  for (const check of view.checks) lines.push(`  ${check.ok ? pc.green('✓') : pc.red('✗')} ${check.text}`);

  if (view.compared) {
    if (view.baseline) {
      const deltas = compareBaseline(view.current, view.baseline).map(
        (d) => `${d.label} ${deltaText(d.pct, d.lowerIsBetter)}`,
      );
      lines.push(
        `  baseline ${view.baseline.timestamp.slice(0, 16).replace('T', ' ')} (${RUNNER_EPOCH}): ${deltas.join(', ')}`,
      );
    } else {
      const older = view.olderBaselines > 0 ? `, ${view.olderBaselines} older-runner entries kept` : '';
      lines.push(pc.dim(`  no comparable baseline: first ${RUNNER_EPOCH} run${older}`));
    }
    if (view.saved !== null) lines.push(pc.dim(`  baseline saved (${view.saved} run${view.saved === 1 ? '' : 's'})`));
  }
  lines.push(pc.dim(`  log ${view.logFile}`));
  return lines;
}

/** One line per scenario for `--all`: the outcome, the primary latency and what failed. */
export function compactLine(view: SummaryView): string {
  const failed = view.checks.filter((check) => !check.ok);
  const mark = failed.length ? pc.red('✗') : pc.green('✓');
  const reqs = view.requests > 0 ? ` · ${count(view.requests)} req · p95 ${ms(view.http?.p95 ?? 0)}` : '';
  const primary = view.current.primary.metric.startsWith('http.')
    ? ''
    : ` · ${view.current.primary.metric} ${ms(view.current.primary.value)}`;
  const reasons = failed.length ? pc.red(` · ${failed.map((check) => check.text).join('; ')}`) : '';
  return `${mark} ${view.scenario}${pc.dim(`${reqs}${primary}`)}${reasons}`;
}

/** One scenario of `--all`, as its row of the closing table reads it. */
export interface SuiteRow {
  name: string;
  ok: boolean;
  current: BaselineEntry;
  baseline: BaselineEntry | null;
  /** The app's own cells by column, such as how long the CDC worker needed after the run. */
  columns: Record<string, string>;
}

/** The closing table of `--all`: a row per scenario, the app's columns, and the primary latency's change. */
export function suiteLines(rows: SuiteRow[]): string[] {
  const extra = [...new Set(rows.flatMap((row) => Object.keys(row.columns)))];
  const heads = ['Req/s', 'p50', 'p95', 'p99', 'Errors', ...extra];
  const num = (n: number) => (n === 0 ? '-' : n < 10 ? n.toFixed(1) : String(Math.round(n)));
  const lines = ['', `${pc.bold('Summary')} ${pc.dim('· all scenarios')}`, ''];
  lines.push(
    `  ${pc.bold(pad('Scenario', 22, true))} ${heads.map((head) => pc.bold(pad(head, 8))).join(' ')} ${pc.bold(pad('Primary Δ', 10))}`,
  );
  lines.push(`  ${'─'.repeat(22 + heads.length * 9 + 11)}`);
  for (const row of rows) {
    const { current, baseline } = row;
    const delta = baseline
      ? deltaText(
          baseline.primary.value === 0
            ? null
            : ((current.primary.value - baseline.primary.value) / baseline.primary.value) * 100,
          true,
        )
      : pc.dim(row.ok ? 'new' : '-');
    const cells = [current.requestRate, current.p50, current.p95, current.p99].map(num);
    cells.push(String(current.errors), ...extra.map((column) => row.columns[column] ?? '-'));
    lines.push(
      `  ${pad(row.name, 22, true)} ${cells.map((cell) => pad(cell, 8)).join(' ')} ${padVisible(delta, 10, 'end')}${row.ok ? '' : pc.red('  ✗')}`,
    );
  }
  lines.push('');
  return lines;
}
