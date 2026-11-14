/**
 * Audit command for the Cella CLI.
 *
 * One table and one checkbox for outdated packages and runtime pins (Node, pnpm, image tags). The
 * picked updates become file edits that the security pass (see security-pass.ts) stages, checks
 * and writes, so the workspace changes once and only with a single install. Below the table, the
 * security fixes this machine's own Node, pnpm and gh miss (see machine.ts), and what pnpm audit
 * reports before the prompt that the security pass waits for.
 */

import { readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { checkbox, Separator } from '@inquirer/prompts';
import pc from '../utils/colors';
import { checkMark, createSpinner, hyperlink, spinnerFail, spinnerSuccess, warningMark } from '../utils/display';
import { getEnv } from '../utils/env';
import {
  type OutdatedPackage,
  readReleaseAgeMinutes,
  runPnpmAudit,
  runPnpmJson,
  severities,
  type VulnerabilitySeverity,
  worstSeverity,
} from '../utils/pnpm';
import { isBreakingJump } from '../utils/versions';
import { readTopLevel } from '../utils/workspace-yaml';
import { fetchFeeds, missingNodeImages } from './feeds';
import { formatDependents, middleTruncate, printAdvisoryRows, severityDot } from './format';
import { type LocalToolCheck, planLocalTools, readLocalTools } from './machine';
import {
  applyRuntimeUpdate,
  editJsonText,
  pinLocation,
  planRuntimeUpdates,
  type RuntimeUpdate,
  readRuntimePins,
} from './runtimes';
import { runSecurityPass, type SecurityPassOutcome, type WorkspaceEdits } from './security-pass';
import { type Advisory, advisoriesFromAudit } from './security-plan';

/** The manifest sections an update rewrites, as `pnpm up --latest` does. */
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** One row of the update table and the checkbox: an outdated package or a runtime pin. */
interface UpdateRow {
  /** The checkbox value: pnpm's outdated key for a package, `runtime:<file>:<name>` for a runtime pin. */
  key: string;
  /** The package name as a manifest lists it, or the runtime's name. */
  name: string;
  current: string;
  latest: string;
  dependentPackages: OutdatedPackage['dependentPackages'];
  isDev: boolean;
  /** The update leaves the range a caret allows: another major, or another minor below 1.0. */
  breaking: boolean;
  /** Workspace names where this package is pinned to an exact version (no ^ or ~) */
  pinnedIn: string[];
  repoUrl: string | null;
  releasesUrl: string | null;
  /** The highest severity the audit reports for the package, or null when it reports none. */
  severity: VulnerabilitySeverity | null;
  /** Set for a runtime pin (Node, pnpm, an image tag) shown among the packages. */
  runtime?: RuntimeUpdate;
}

const exitCode = (outcome: SecurityPassOutcome) => (outcome === 'failed' ? 1 : 0);

/** The runtime pins, this machine's tools and the feeds both are checked against, each feed asked once. */
async function readRuntimes(repoRoot: string, now: number) {
  const [pins, tools] = await Promise.all([readRuntimePins(repoRoot), readLocalTools()]);
  const versions = (...found: Array<string | null | undefined>) => [...new Set(found.flatMap((v) => v ?? []))];
  const feeds = await fetchFeeds(
    {
      node: versions(pins.node, tools.node.version),
      pnpm: versions(pins.pnpm, tools.pnpm?.version),
      images: pins.images,
      gh: tools.gh?.version ?? null,
    },
    repoRoot,
    now,
  );
  return { pins, tools, feeds };
}

/**
 * Report the updates and the security plan; with `fix`, ask which to take and write them.
 * @returns 1 when a step gave no answer or failed, 0 for a report, a cancelled prompt and a written fix
 */
export async function runAudit(repoRoot: string, fix: boolean): Promise<number> {
  const spinner = createSpinner('checking packages and runtimes...');
  try {
    const now = Date.now();
    // --long adds each package's latest manifest, which holds its repository URL.
    const [outdated, auditResult, releaseAgeMinutes, { pins, tools, feeds }] = await Promise.all([
      runPnpmJson(['-r', 'outdated', '--json', '--long'], repoRoot),
      runPnpmAudit(repoRoot),
      readReleaseAgeMinutes(repoRoot),
      readRuntimes(repoRoot, now),
    ]);
    if (!outdated) {
      spinnerFail('pnpm outdated gave no answer: run pnpm -r outdated to see why');
      console.info(`${warningMark} security pass skipped: it runs after the update check`);
      return 1;
    }

    const runtimes = planRuntimeUpdates(pins, feeds, { releaseAgeMinutes, now });
    const advisories = auditResult ? advisoriesFromAudit(auditResult) : null;
    const rows = [
      ...packageRows(outdated as Record<string, OutdatedPackage>, advisories ?? []),
      ...runtimes.updates.map(runtimeRow),
    ];

    if (rows.length === 0) {
      spinnerSuccess('all packages and runtimes are up to date');
    } else {
      spinner.stop();
      printUpdateTable(rows);
      printManifestLinks(rows, repoRoot);
    }
    printNotes(repoRoot, runtimes.unchecked);
    console.info();
    printLocalTools(planLocalTools(tools, feeds, { releaseAgeMinutes, now }));

    // A report asks nothing and writes nothing
    if (!fix || rows.length === 0) return exitCode(await runSecurityPass(repoRoot, { apply: fix, releaseAgeMinutes }));

    printReported(advisories);
    const selected = await promptForUpdates(rows);
    if (!selected) return 0;
    const chosen = rows.filter((row) => selected.includes(row.key));
    const node = chosen.find((row) => row.runtime?.pin.type === 'node')?.runtime;
    const missingImages = node ? await missingNodeImages(node.target, pins.nodeImageSuffixes) : [];
    const plan = planEdits(repoRoot, chosen, missingImages);
    for (const warning of plan.warnings) console.info(`${warningMark} ${warning}`);
    for (const [label, items] of plan.changed)
      console.info(`${pc.cyan('↑')} ${pc.bold(label)}: ${pc.dim(items.join(', '))}`);
    if (plan.changed.size > 0) console.info();

    const outcome = await runSecurityPass(repoRoot, { apply: true, releaseAgeMinutes, edits: plan.edits });
    if (outcome === 'written') printNext(plan.bumped);
    return exitCode(outcome);
  } finally {
    spinner.stop();
  }
}

/**
 * The package name of a `pnpm -r outdated --json` key. pnpm keys a name that has several entries
 * (another installed version or dependency type) as `name@current (dev)`.
 */
function outdatedPackageName(key: string): string {
  const name = key.split(' ')[0];
  const at = name.indexOf('@', 1);
  return at === -1 ? name : name.slice(0, at);
}

/** The most severe advisory on a package; null when it has none. */
const severityOf = (advisories: Advisory[], name: string) =>
  worstSeverity(advisories.filter((advisory) => advisory.module === name).map((advisory) => advisory.severity));

/** A repository URL from package metadata in a plain https:// form, and its releases page when it is on GitHub. */
function repoLinks(repositoryUrl: string | undefined): Pick<UpdateRow, 'repoUrl' | 'releasesUrl'> {
  const repoUrl =
    repositoryUrl
      ?.replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/^git:\/\//, 'https://') || null;
  const host = URL.parse(repoUrl ?? '')?.hostname;
  return { repoUrl, releasesUrl: host === 'github.com' || host === 'www.github.com' ? `${repoUrl}/releases` : null };
}

/** The outdated packages as table rows, sorted by the workspaces that depend on them. */
function packageRows(outdated: Record<string, OutdatedPackage>, advisories: Advisory[]): UpdateRow[] {
  // Each dependent's package.json, read once: its dependency maps tell an exact pin.
  const manifests = new Map<string, Partial<Record<OutdatedPackage['dependencyType'], Record<string, string>>>>();
  const manifestAt = (location: string) => {
    if (!manifests.has(location)) {
      try {
        manifests.set(location, JSON.parse(readFileSync(join(location, 'package.json'), 'utf8')) ?? {});
      } catch {
        manifests.set(location, {});
      }
    }
    return manifests.get(location);
  };

  const rows = Object.entries(outdated).map(([key, pkg]): UpdateRow => {
    const name = outdatedPackageName(key);
    // pnpm leaves `current` out for a dependency that is not installed.
    const current = pkg.current ?? 'missing';
    return {
      key,
      name,
      current,
      latest: pkg.latest,
      dependentPackages: pkg.dependentPackages,
      isDev: pkg.dependencyType === 'devDependencies',
      breaking: isBreakingJump(current, pkg.latest),
      // An exact pin: a specifier without ^, ~ or > in front
      pinnedIn: pkg.dependentPackages
        .filter(({ location }) => /^[^^~>]/.test(manifestAt(location)?.[pkg.dependencyType]?.[name] ?? ''))
        .map((dependent) => dependent.name),
      ...repoLinks(pkg.latestManifest?.repository?.url),
      severity: severityOf(advisories, name),
    };
  });

  return rows.sort((a, b) => inText(a).localeCompare(inText(b)) || a.name.localeCompare(b.name));
}

function runtimeRow(update: RuntimeUpdate): UpdateRow {
  return {
    key: `runtime:${update.file}:${update.name}`,
    name: update.name,
    current: update.current,
    latest: update.target,
    dependentPackages: [],
    isDev: false,
    breaking: isBreakingJump(update.current, update.target),
    pinnedIn: [],
    repoUrl: null,
    releasesUrl: update.releasesUrl,
    severity: update.severity,
    runtime: update,
  };
}

/** The "in" column: where a runtime is pinned, or the workspaces that depend on the package, as "first +N". */
const inText = (row: UpdateRow): string =>
  row.runtime ? pinLocation(row.runtime.file) : formatDependents(row.dependentPackages.map((d) => d.name));

/** The table of updates: severity dot, name, current and latest version, where it is used, and links. */
function printUpdateTable(rows: UpdateRow[]): void {
  const tag = (row: UpdateRow) => (row.runtime ? ' (runtime)' : row.isDev ? ' (dev)' : '');
  const nameWidth = Math.min(35, Math.max(7, ...rows.map((row) => row.name.length + tag(row).length)));
  const currentWidth = Math.max(7, ...rows.map((row) => row.current.length));
  const latestWidth = Math.max(6, ...rows.map((row) => row.latest.length));
  const inWidth = Math.min(15, Math.max(10, ...rows.map((row) => inText(row).length)));

  // The severity column is a single dot, so it gets no width budget.
  const header = [' ', 'package'.padEnd(nameWidth), 'current'.padEnd(currentWidth), 'latest'.padEnd(latestWidth)];
  console.info([...header, 'in'.padEnd(inWidth), 'links'].map((title) => pc.bold(title)).join(' '));

  for (const row of rows) {
    const name = pc.white(middleTruncate(`${row.name}${tag(row)}`, nameWidth).padEnd(nameWidth));
    const latest = pc.green(row.latest.padEnd(latestWidth));
    const links = [
      row.releasesUrl ? hyperlink(pc.blue('rel'), row.releasesUrl) : '',
      row.repoUrl ? hyperlink(pc.cyan('repo'), row.repoUrl) : '',
    ].filter(Boolean);
    console.info(
      [
        severityDot(row.severity),
        name,
        pc.red(row.current.padEnd(currentWidth)),
        row.breaking ? pc.bold(latest) : latest,
        pc.dim(middleTruncate(inText(row), inWidth).padEnd(inWidth)),
        links.length > 0 ? links.join(' ') : pc.dim('n/a'),
      ].join(' '),
    );
  }
}

/** A link to each dependent's package.json, with how many of the rows it lists. */
function printManifestLinks(rows: UpdateRow[], repoRoot: string): void {
  console.info();
  const dependents = new Map<string, { location: string; count: number }>();
  for (const { name, location } of rows.flatMap((row) => row.dependentPackages)) {
    const key = name || basename(location);
    const entry = dependents.get(key) ?? { location, count: 0 };
    dependents.set(key, { ...entry, count: entry.count + 1 });
  }
  const sorted = [...dependents.entries()].sort(([a], [b]) => a.localeCompare(b));
  const width = Math.max(0, ...sorted.map(([name]) => name.length));
  for (const [name, { location, count }] of sorted) {
    const manifest = join(location, 'package.json');
    const link = hyperlink(relative(repoRoot, manifest), `file://${manifest}`);
    console.info(`  ${pc.dim('•')} ${name.padEnd(width)}  ${link} ${pc.dim(`${count}`)}`);
  }
}

/** The packages pnpm holds back (`updateConfig.ignoreDependencies`), and the runtimes whose feed did not answer. */
function printNotes(repoRoot: string, unchecked: string[]): void {
  let held: string[] = [];
  try {
    const updateConfig = readTopLevel(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'), 'updateConfig');
    const ignored = (updateConfig as { ignoreDependencies?: unknown } | undefined)?.ignoreDependencies;
    held = Array.isArray(ignored) ? ignored.map(String) : [];
  } catch {
    // No workspace file: nothing is held.
  }
  if (held.length > 0) console.info(`  ${pc.dim(`held: ${held.join(', ')} · pnpm-workspace.yaml updateConfig`)}`);
  if (unchecked.length > 0)
    console.info(`  ${pc.dim(`not checked, no answer from the feed: ${unchecked.join(', ')}`)}`);
}

/** The tools this machine works with, each with the security fixes it misses and how to get them. */
function printLocalTools(checks: LocalToolCheck[]): void {
  const width = Math.max(...checks.map((tool) => `${tool.name} ${tool.version}`.length));
  console.info(pc.bold('this machine'));
  for (const tool of checks) {
    const label = `${tool.name} ${tool.version}`.padEnd(width);
    const detail = tool.severity
      ? `${tool.note} ${pc.dim('·')} ${tool.fix}`
      : pc.dim(tool.note || 'no missing security fixes');
    console.info(`${severityDot(tool.severity)} ${label}  ${detail}`);
  }
  console.info();
}

/**
 * What pnpm audit reports on the workspace as it stands, most severe first. A transitive package has
 * no row in the table, and a cancelled prompt never reaches the security pass.
 */
function printReported(advisories: Advisory[] | null): void {
  if (!advisories) {
    console.info(`${warningMark} pnpm audit gave no answer: a row in the table can lack its dot`);
    console.info();
    return;
  }
  if (advisories.length === 0) {
    console.info(`${checkMark} pnpm audit reports nothing ${pc.dim('· with the current overrides and ignores')}`);
    console.info();
    return;
  }

  const modules = Map.groupBy(advisories, (advisory) => advisory.module);
  const rows = [...modules].map(([module, own]) => ({
    module,
    severity: worstSeverity(own.map((advisory) => advisory.severity)) ?? own[0].severity,
    versions: [...new Set(own.flatMap((advisory) => advisory.installed))].join(', '),
    note: `${formatDependents([...new Set(own.flatMap((advisory) => advisory.via))])}${own.some((advisory) => advisory.direct) ? ' (direct)' : ''}`,
  }));
  rows.sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity));
  printAdvisoryRows(`${pc.bold('pnpm audit')} ${pc.dim('· with the current overrides and ignores')}`, rows);
}

/** The grouped checkbox choices: runtimes, pinned packages, then the regular ones. A red dot starts ticked. */
function updateChoices(rows: UpdateRow[]): Array<{ name: string; value: string; checked: boolean } | Separator> {
  const choice = (row: UpdateRow) => {
    const notes = [
      row.breaking ? pc.bold('breaking') : '',
      row.runtime?.note ? pc.dim(row.runtime.note) : '',
      row.pinnedIn.length > 0 ? `${warningMark} ${pc.dim(`pinned in ${row.pinnedIn.join(', ')}`)}` : '',
    ].filter(Boolean);
    return {
      name: `${row.name}${row.isDev ? pc.dim(' (dev)') : ''}  ${pc.red(row.current)} → ${pc.green(row.latest)}${notes.length > 0 ? `  ${notes.join('  ')}` : ''}`,
      value: row.key,
      checked: row.severity === 'critical' || row.severity === 'high',
    };
  };

  const runtimes = rows.filter((row) => row.runtime);
  const pinned = rows.filter((row) => !row.runtime && row.pinnedIn.length > 0);
  const regular = rows.filter((row) => !row.runtime && row.pinnedIn.length === 0);
  const groups: Array<[label: string | null, UpdateRow[]]> = [
    [pc.yellow(`── runtimes (${runtimes.length}) ──`), runtimes],
    [pc.yellow(`── pinned (${pinned.length}) ──`), pinned],
    // Regular packages get a heading only below another group.
    [runtimes.length + pinned.length > 0 ? pc.dim(`── packages (${regular.length}) ──`) : null, regular],
  ];
  return groups.flatMap(([label, group]) =>
    group.length === 0 ? [] : [...(label ? [new Separator(label)] : []), ...group.map(choice)],
  );
}

/** The one prompt of the update step; null when it was cancelled. Submitting with nothing ticked skips the updates. */
async function promptForUpdates(rows: UpdateRow[]): Promise<string[] | null> {
  try {
    const selected = await checkbox({
      message: `toggle what to update ${pc.dim('· enter with nothing ticked skips')}`,
      choices: updateChoices(rows),
      required: false,
      pageSize: 20,
      loop: false,
      theme: {
        icon: { cursor: '❯ ' },
        style: {
          highlight: (text: string) => text,
          keysHelpTip: (keys: [string, string][]) => keys.map(([key, action]) => `${pc.dim(key)} ${action}`).join('  '),
          renderSelectedChoices: (selectedChoices: Array<{ value?: string }>) =>
            pc.dim(`${selectedChoices.length} selected`),
        },
      },
    });
    console.info();
    return selected;
  } catch {
    return null;
  }
}

/** The text of a runtime bump in the summary, e.g. `engines.node 26.12.1`. */
function bumpText(update: RuntimeUpdate): string {
  if (update.pin.type === 'node') return `engines.node ${update.target}`;
  if (update.pin.type === 'pnpm') return `packageManager pnpm@${update.target}`;
  return update.pin.to;
}

/**
 * The chosen updates as file contents, with the changed items per file and the warnings to show. A
 * dependency's specifier keeps its prefix; one the audit cannot rewrite is left as written. A Node
 * bump waits while Docker Hub lacks any of `missingImages`, the images the Dockerfiles build from.
 */
function planEdits(
  repoRoot: string,
  chosen: UpdateRow[],
  missingImages: string[],
): { edits: WorkspaceEdits; bumped: RuntimeUpdate[]; changed: Map<string, string[]>; warnings: string[] } {
  const edits: WorkspaceEdits = { manifests: {}, files: {} };
  const changed = new Map<string, string[]>();
  const warnings: string[] = [];
  const bumped: RuntimeUpdate[] = [];
  // A file a dependency update changed is a manifest to resolve, also when a runtime bump edits it after.
  const edit = (file: string, label: string, item: string, resolves: boolean, change: (content: string) => string) => {
    const content = edits.manifests[file] ?? edits.files[file] ?? readFileSync(join(repoRoot, file), 'utf8');
    const next = change(content);
    if (next === content) return;
    (resolves || file in edits.manifests ? edits.manifests : edits.files)[file] = next;
    changed.set(label, [...(changed.get(label) ?? []), item]);
  };

  for (const row of chosen) {
    if (row.runtime) continue;
    for (const { name: dependent, location } of row.dependentPackages) {
      const file = relative(repoRoot, join(location, 'package.json'));
      edit(file, dependent || file, row.name, true, (content) =>
        editJsonText(content, (json) => {
          for (const section of dependencySections) {
            const deps = json[section] as Record<string, string> | undefined;
            const spec = deps?.[row.name];
            if (!deps || spec === undefined) continue;
            const next = rewriteSpecifier(spec, row.latest);
            if (next) deps[row.name] = next;
            else warnings.push(`${row.name} in ${dependent || file} left as written: ${spec}`);
          }
        }),
      );
    }
  }

  for (const { runtime: update } of chosen) {
    if (!update) continue;
    if (update.pin.type === 'node' && missingImages.length > 0) {
      warnings.push(`node ${update.target} skipped: ${missingImages.join(', ')} is not on docker hub yet`);
      continue;
    }
    edit(update.file, update.file, bumpText(update), false, (content) => applyRuntimeUpdate(content, update));
    bumped.push(update);
  }

  return { edits, bumped, changed, warnings };
}

/**
 * The specifier that moves a dependency to `latest` and keeps its prefix (`^`, `~` or exact), as
 * `pnpm up --latest` writes it; null for one the audit leaves as written (`workspace:`, `catalog:`,
 * `npm:` aliases, operator ranges, tags).
 */
export function rewriteSpecifier(spec: string, latest: string): string | null {
  const match = spec.match(/^([\^~]?)\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/);
  return match ? `${match[1]}${latest}` : null;
}

/** The steps a runtime bump leaves to the developer: this machine's Node, and a local build of each changed image. */
function printNext(bumped: RuntimeUpdate[]): void {
  const steps: Array<[command: string, why: string]> = [];
  const node = bumped.find((update) => update.pin.type === 'node');
  if (node && process.version !== `v${node.target}`) {
    const command = getEnv('VOLTA_HOME') ? `volta install node@${node.target}` : `switch to node ${node.target}`;
    steps.push([command, `this machine runs ${process.version.slice(1)}`]);
  }
  for (const update of bumped) {
    if (update.pin.type === 'image') steps.push([`docker build -f ${update.file} .`, 'check that the image builds']);
  }
  if (steps.length === 0) return;

  const width = Math.max(...steps.map(([command]) => command.length));
  console.info(pc.bold('next'));
  for (const [command, why] of steps) console.info(`  ${pc.dim('•')} ${command.padEnd(width)}   ${pc.dim(why)}`);
  console.info();
}
