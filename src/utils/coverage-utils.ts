/**
 * Coverage overview for the stats service, from the `.coverage/coverage-summary.json` that the
 * `json-summary` Vitest reporter writes on `pnpm test`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import pc from './colors';

/** A single metric block from a coverage-summary.json entry. */
interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number | 'Unknown';
}

/** One file (or the `total`) entry in coverage-summary.json. */
interface CoverageEntry {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

/** Shape of Vitest's coverage-summary.json. Keys are absolute file paths plus `total`. */
type CoverageSummary = Record<string, CoverageEntry> & { total: CoverageEntry };

/** Coverage data is considered stale after this many ms (7 days). */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Color a percentage: green ≥ 80, yellow ≥ 50, red below. */
function colorPct(pct: CoverageMetric['pct']): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return pc.dim('n/a');

  const label = `${pct.toFixed(2)}%`;
  if (pct >= 80) return pc.green(label);
  if (pct >= 50) return pc.yellow(label);
  return pc.red(label);
}

/** Human-friendly "x days/hours ago" from a timestamp. */
function formatAge(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const mins = Math.floor(ms / (60 * 1000));
  return `${mins} minute${mins === 1 ? '' : 's'} ago`;
}

/** Print a compact coverage overview from the cached summary file. */
export function printCoverageSummary(forkPath: string): void {
  const file = join(forkPath, '.coverage', 'coverage-summary.json');
  let summary: CoverageSummary | undefined;
  let mtimeMs = 0;
  let problem = 'no coverage data found';
  if (existsSync(file)) {
    try {
      mtimeMs = statSync(file).mtimeMs;
      summary = JSON.parse(readFileSync(file, 'utf8')) as CoverageSummary;
    } catch {
      problem = 'could not read coverage-summary.json';
    }
  }
  if (!summary || !Object.keys(summary).some((key) => key !== 'total')) {
    console.info(pc.bold('coverage'));
    console.info(pc.yellow(`  ${problem}: run \`pnpm test\` to generate it`));
    console.info();
    return;
  }

  const ageMs = Date.now() - mtimeMs;
  const stale = ageMs > STALE_THRESHOLD_MS;

  // Roll up per-package line coverage by the first path segment relative to root.
  const perPackage = new Map<string, { covered: number; total: number }>();
  for (const [key, entry] of Object.entries(summary)) {
    if (key === 'total') continue;
    const rel = relative(forkPath, key);
    if (rel.startsWith('..')) continue;
    const pkg = rel.split(sep)[0];
    const acc = perPackage.get(pkg) ?? { covered: 0, total: 0 };
    acc.covered += entry.lines.covered;
    acc.total += entry.lines.total;
    perPackage.set(pkg, acc);
  }

  // Header with freshness indicator.
  const ageLabel = formatAge(ageMs);
  console.info(pc.bold('coverage'), pc.dim(`(updated ${ageLabel})`));
  if (stale) {
    console.info(pc.yellow('  ⚠ data is older than 7 days: run `pnpm test` to refresh'));
  }

  // Overall totals.
  const total = summary.total;
  console.info(
    `  ${pc.bold('overall')}  ` +
      `lines ${colorPct(total.lines.pct)} ${pc.dim(`(${total.lines.covered}/${total.lines.total})`)}  ` +
      `funcs ${colorPct(total.functions.pct)}  ` +
      `branches ${colorPct(total.branches.pct)}`,
  );

  // Per-package line coverage, worst first.
  const rows = [...perPackage.entries()]
    .map(([pkg, v]) => ({ pkg, pct: v.total ? (100 * v.covered) / v.total : 0, ...v }))
    .sort((a, b) => a.pct - b.pct);

  const nameWidth = Math.max(...rows.map((r) => r.pkg.length), 0);
  for (const r of rows) {
    console.info(`    ${r.pkg.padEnd(nameWidth)}  ${colorPct(r.pct)} ${pc.dim(`(${r.covered}/${r.total})`)}`);
  }
  console.info();
}
