import pc from '../utils/colors';
import { createSpinner, divider, spinnerSuccess } from '../utils/display';
import { git } from '../utils/git';
import { printCoverageSummary } from './coverage';
import { classifyFile, type FileKind, getWorkspacePackages, matchPackage, sourceExtensions } from './file-kinds';

/** Per-package file and LOC counts, broken down by category */
interface PackageStats {
  total: number;
  loc: number;
  categories: Record<FileKind, { files: number; loc: number }>;
}

/** Stats result for display or JSON output */
interface StatsResult {
  total: number;
  totalLoc: number;
  categories: Record<FileKind, { files: number; loc: number }>;
  packages: Record<string, PackageStats>;
}

/** Pathspec patterns for source extensions */
const sourcePathspecs = [...sourceExtensions].map((ext) => `*.${ext}`);

/** File and LOC stats for the repository; one `git grep -c ''` call yields paths and line counts. */
async function collectStats(repoRoot: string): Promise<StatsResult> {
  // Tracked source files with line counts (respects .gitignore, ~15ms).
  const output = await git(['grep', '-c', '', '--', ...sourcePathspecs], repoRoot, { ignoreErrors: true });

  const packages = await getWorkspacePackages(repoRoot);

  // Parse "path:count" lines
  const entries: { path: string; loc: number }[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const sep = line.lastIndexOf(':');
    if (sep === -1) continue;
    entries.push({ path: line.slice(0, sep), loc: Number.parseInt(line.slice(sep + 1), 10) });
  }

  const emptyCat = (): Record<FileKind, { files: number; loc: number }> => ({
    source: { files: 0, loc: 0 },
    test: { files: 0, loc: 0 },
    stories: { files: 0, loc: 0 },
    generated: { files: 0, loc: 0 },
    json: { files: 0, loc: 0 },
    docs: { files: 0, loc: 0 },
    other: { files: 0, loc: 0 },
  });
  const categories = emptyCat();
  const pkgStats = new Map<string, PackageStats>();
  let totalLoc = 0;

  for (const { path, loc } of entries) {
    const category = classifyFile(path);
    categories[category].files++;
    categories[category].loc += loc;
    totalLoc += loc;

    const pkg = matchPackage(path, packages);
    let entry = pkgStats.get(pkg);
    if (!entry) {
      entry = { total: 0, loc: 0, categories: emptyCat() };
      pkgStats.set(pkg, entry);
    }
    entry.total++;
    entry.loc += loc;
    entry.categories[category].files++;
    entry.categories[category].loc += loc;
  }

  const sortedPackages = Object.fromEntries(
    [...pkgStats.entries()].sort((a, b) => b[1].categories.source.loc - a[1].categories.source.loc),
  );

  return { total: entries.length, totalLoc, categories, packages: sortedPackages };
}

function pad(n: number, width = 6): string {
  return String(n).padStart(width);
}

function formatLoc(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtPct(value: number, total: number): string {
  const pct = ((value / total) * 100).toFixed(1);
  return `${pct.padStart(5)}%`;
}

function printStats(stats: StatsResult, verbose: boolean): void {
  console.info();
  console.info(
    `  ${pc.bold('code files'.padEnd(13))}  ${String(stats.total)}  ${pc.dim(`(${[...sourceExtensions].join(' ')})`)}`,
  );
  console.info(`  ${pc.bold('lines of code')}  ${pc.cyan(formatLoc(stats.totalLoc))}`);
  console.info();

  const catEntries: [string, { files: number; loc: number }][] = [
    ['source & config', stats.categories.source],
    ['test', stats.categories.test],
    ['stories', stats.categories.stories],
    ['generated', stats.categories.generated],
    ['json', stats.categories.json],
  ];
  for (const [label, data] of catEntries) {
    console.info(
      `  ${pad(data.files)} ${pc.dim(fmtPct(data.files, stats.total))}  ${label.padEnd(18)} ${pc.cyan(formatLoc(data.loc).padStart(8))}  ${pc.dim(fmtPct(data.loc, stats.totalLoc))}`,
    );
  }

  console.info();
  console.info(divider);
  console.info();

  const header = verbose
    ? `  ${''.padEnd(6)}  ${'package'.padEnd(18)} ${'loc'.padStart(8)} ${'test'.padStart(6)} ${'story'.padStart(6)} ${'gen'.padStart(6)} ${'json'.padStart(6)} ${'src'.padStart(6)}`
    : '  source & config by package';
  console.info(pc.dim(header));
  const { source } = stats.categories;
  for (const [name, { categories: c }] of Object.entries(stats.packages)) {
    if (c.source.files === 0) continue;
    // Verbose: file counts per category. Plain: shares of all source & config files and lines.
    const head = verbose
      ? pc.dim(pad(c.source.files))
      : `${pad(c.source.files)} ${pc.dim(fmtPct(c.source.files, source.files))}`;
    const tail = verbose
      ? ` ${[c.test, c.stories, c.generated, c.json, c.source].map((cat) => pc.dim(pad(cat.files))).join(' ')}`
      : `  ${pc.dim(fmtPct(c.source.loc, source.loc))}`;
    console.info(`  ${head}  ${name.padEnd(18)} ${pc.cyan(formatLoc(c.source.loc).padStart(8))}${tail}`);
  }

  console.info();
}

export async function runStats(repoRoot: string, verbose: boolean): Promise<void> {
  createSpinner('counting files...');
  const stats = await collectStats(repoRoot);
  spinnerSuccess('counted raw lines of code');

  printStats(stats, verbose);
  console.info();
  printCoverageSummary(repoRoot);
}
