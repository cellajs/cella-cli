/**
 * Audit service for the Cella CLI.
 *
 * One table and one checkbox for outdated packages and runtime pins (Node, pnpm, image tags). The
 * picked updates become file edits that the security pass (see audit-security.ts) stages, checks
 * and writes, so the workspace changes once and only with a single install. Below the table, the
 * security fixes this machine's own Node, pnpm and gh miss (see local-tools.ts).
 */

import { readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { checkbox, Separator } from '@inquirer/prompts';
import type { RuntimeConfig } from '../config/types';
import {
  type EnhancedPackageInfo,
  editJsonText,
  formatDependents,
  getReleasesUrl,
  getRepoUrl,
  getVulnIcon,
  middleTruncate,
  type OutdatedPackage,
  outdatedPackageName,
  readReleaseAgeMinutes,
  rewriteSpecifier,
  runPnpmAudit,
  runPnpmJson,
} from '../utils/audit-utils';
import pc from '../utils/colors';
import { createSpinner, hyperlink, spinnerFail, spinnerSuccess, warningMark } from '../utils/display';
import { getEnv } from '../utils/env';
import { type LocalToolCheck, planLocalTools, readLocalTools } from '../utils/local-tools';
import {
  applyRuntimeUpdate,
  fetchRuntimeFeeds,
  missingNodeImages,
  pinLocation,
  planRuntimeUpdates,
  type RuntimeUpdate,
  readRuntimePins,
} from '../utils/runtimes';
import { advisoriesFromAudit, SEVERITIES } from '../utils/security-plan';
import { isBreakingJump } from '../utils/versions';
import { readTopLevel } from '../utils/workspace-yaml';
import { runSecurityPass, type WorkspaceEdits } from './audit-security';

/** The manifest sections an update rewrites, as `pnpm up --latest` does. */
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** A dependent workspace's package.json: its dependency maps, for pin detection. */
type DependentPkgJson = Partial<Record<'dependencies' | 'devDependencies', Record<string, string>>>;

/** Reader for dependents' package.jsons that loads each one once, caching by location. */
function createDependentPkgReader(): (location: string) => DependentPkgJson | null {
  const cache = new Map<string, DependentPkgJson | null>();
  return (location) => {
    let cached = cache.get(location);
    if (cached === undefined) {
      try {
        cached = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'));
      } catch {
        cached = null;
      }
      cache.set(location, cached ?? null);
    }
    return cached ?? null;
  };
}

export async function runAudit(config: RuntimeConfig): Promise<void> {
  const { forkPath } = config;

  const spinner = createSpinner('checking packages and runtimes...');
  try {
    const pins = await readRuntimePins(forkPath);
    const now = Date.now();
    // --long adds each package's latest manifest, which holds its repository URL.
    const [outdated, auditResult, releaseAgeMinutes, feeds, machine] = await Promise.all([
      runPnpmJson(['-r', 'outdated', '--json', '--long'], forkPath),
      runPnpmAudit(forkPath),
      readReleaseAgeMinutes(forkPath),
      fetchRuntimeFeeds(pins, forkPath, now),
      readLocalTools(forkPath, now),
    ]);
    if (!outdated) {
      spinnerFail('pnpm outdated gave no answer: run pnpm -r outdated to see why');
      console.info(`${warningMark} security pass skipped: it runs after the update check`);
      return;
    }

    const runtimes = planRuntimeUpdates(pins, feeds, { releaseAgeMinutes, now });
    const localTools = planLocalTools(machine, { releaseAgeMinutes, now });
    const rows = [
      ...packageRows(outdated as Record<string, OutdatedPackage>, auditResult ? advisoriesFromAudit(auditResult) : []),
      ...runtimes.updates.map(runtimeRow),
    ];

    if (rows.length === 0) {
      spinnerSuccess('all packages and runtimes are up to date');
      printNotes(forkPath, runtimes.unchecked);
      console.info();
      printLocalTools(localTools);
      await runSecurityPass(forkPath, { apply: !config.list, releaseAgeMinutes });
      return;
    }

    spinner.stop();
    printOutdatedResults(rows, forkPath);
    printNotes(forkPath, runtimes.unchecked);
    console.info();
    printLocalTools(localTools);

    // --list is the non-interactive mode: report only, no prompts and no writes.
    if (config.list) {
      await runSecurityPass(forkPath, { apply: false, releaseAgeMinutes });
      return;
    }

    const selected = await promptForUpdates(rows);
    if (!selected) return;
    const { edits, bumped } = await planEdits(forkPath, rows, selected, pins.nodeImageSuffixes);
    if (await runSecurityPass(forkPath, { apply: true, releaseAgeMinutes, edits })) printNext(bumped);
  } finally {
    spinner.stop();
  }
}

/** The outdated packages as table rows, sorted by the workspaces that depend on them. */
function packageRows(outdated: Record<string, OutdatedPackage>, advisories: ReturnType<typeof advisoriesFromAudit>) {
  const severityOf = (name: string) =>
    SEVERITIES.find((severity) => advisories.some((a) => a.module === name && a.severity === severity)) ?? null;
  const readDependentPkg = createDependentPkgReader();

  const rows: EnhancedPackageInfo[] = Object.entries(outdated).map(([key, pkg]) => {
    const name = outdatedPackageName(key);
    const repoUrl = getRepoUrl(pkg.latestManifest?.repository?.url);
    // pnpm leaves `current` out for a dependency that is not installed.
    const current = pkg.current ?? 'missing';

    // Workspaces that pin this package to an exact version.
    const pinnedIn: string[] = [];
    for (const d of pkg.dependentPackages) {
      const spec = readDependentPkg(d.location)?.[pkg.dependencyType]?.[name] || '';
      if (spec && !spec.startsWith('^') && !spec.startsWith('~') && !spec.startsWith('>')) {
        pinnedIn.push(d.name);
      }
    }

    return {
      key,
      name,
      current,
      latest: pkg.latest,
      dependentPackages: pkg.dependentPackages,
      isDev: pkg.dependencyType === 'devDependencies',
      breaking: isBreakingJump(current, pkg.latest),
      pinnedIn,
      repoUrl,
      releasesUrl: getReleasesUrl(repoUrl),
      severity: severityOf(name),
    };
  });

  return rows.sort((a, b) => inText(a).localeCompare(inText(b)) || a.name.localeCompare(b.name));
}

function runtimeRow(update: RuntimeUpdate): EnhancedPackageInfo {
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

const isRed = (row: EnhancedPackageInfo): boolean => row.severity === 'critical' || row.severity === 'high';

/** The "in" column: where a runtime is pinned, or the workspaces that depend on the package, as "first +N". */
const inText = (row: EnhancedPackageInfo): string =>
  row.runtime ? pinLocation(row.runtime.file) : formatDependents(row.dependentPackages.map((d) => d.name));

function printOutdatedResults(rows: EnhancedPackageInfo[], forkPath: string): void {
  const DEV_TAG = ' (dev)';
  const RUNTIME_TAG = ' (runtime)';
  const MAX_NAME_LEN = 35;
  const MAX_DEPENDENTS_LEN = 15;
  const tag = (row: EnhancedPackageInfo) => (row.runtime ? RUNTIME_TAG : row.isDev ? DEV_TAG : '');
  const maxNameLen = Math.min(MAX_NAME_LEN, Math.max(7, ...rows.map((p) => p.name.length + tag(p).length)));
  const maxCurrentLen = Math.max(7, ...rows.map((p) => p.current.length));
  const maxLatestLen = Math.max(6, ...rows.map((p) => p.latest.length));
  const maxDependentsLen = Math.min(MAX_DEPENDENTS_LEN, Math.max(10, ...rows.map((p) => inText(p).length)));

  // The vuln column is a single dot, so it gets no width budget.
  const header = [
    ' ',
    pc.bold('package'.padEnd(maxNameLen)),
    pc.bold('current'.padEnd(maxCurrentLen)),
    pc.bold('latest'.padEnd(maxLatestLen)),
    pc.bold('in'.padEnd(maxDependentsLen)),
    pc.bold('links'),
  ].join(' ');

  console.info(header);

  for (const pkg of rows) {
    const vulnIndicator = pkg.severity ? getVulnIcon(pkg.severity) : ' ';

    const displayName = middleTruncate(`${pkg.name}${tag(pkg)}`, maxNameLen);
    const name = pc.white(displayName.padEnd(maxNameLen));

    const current = pc.red(pkg.current.padEnd(maxCurrentLen));
    const latestText = pkg.latest.padEnd(maxLatestLen);
    const latest = pkg.breaking ? pc.bold(pc.green(latestText)) : pc.green(latestText);

    const dependents = pc.dim(middleTruncate(inText(pkg), maxDependentsLen).padEnd(maxDependentsLen));

    const links: string[] = [];
    if (pkg.releasesUrl) {
      links.push(hyperlink(pc.blue('rel'), pkg.releasesUrl));
    }
    if (pkg.repoUrl) {
      links.push(hyperlink(pc.cyan('repo'), pkg.repoUrl));
    }

    const linksStr = links.length > 0 ? links.join(' ') : pc.dim('n/a');

    console.info(`${vulnIndicator} ${name} ${current} ${latest} ${dependents} ${linksStr}`);
  }

  // Package.json links with counts by dependent name.
  console.info();
  const dependentMap = new Map<string, { location: string; count: number }>();
  for (const pkg of rows) {
    for (const { name, location } of pkg.dependentPackages) {
      const dependentName = name || basename(location);
      const existing = dependentMap.get(dependentName);
      if (existing) {
        existing.count++;
      } else {
        dependentMap.set(dependentName, { location, count: 1 });
      }
    }
  }
  const sortedDependents = [...dependentMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxDependentNameLen = Math.max(0, ...sortedDependents.map(([name]) => name.length));
  for (const [dependentName, { location, count }] of sortedDependents) {
    const packageJsonPath = join(location, 'package.json');
    const relativePath = relative(forkPath, packageJsonPath);
    const paddedName = dependentName.padEnd(maxDependentNameLen);
    console.info(
      `  ${pc.dim('•')} ${paddedName}  ${hyperlink(relativePath, `file://${packageJsonPath}`)} ${pc.dim(`${count}`)}`,
    );
  }
}

/** The packages pnpm holds back (`updateConfig.ignoreDependencies`), and the runtimes whose feed did not answer. */
function printNotes(forkPath: string, unchecked: string[]): void {
  let held: string[] = [];
  try {
    const updateConfig = readTopLevel(readFileSync(join(forkPath, 'pnpm-workspace.yaml'), 'utf8'), 'updateConfig');
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
    console.info(`${tool.severity ? getVulnIcon(tool.severity) : ' '} ${label}  ${detail}`);
  }
  console.info();
}

/** The grouped checkbox choices: runtimes, pinned packages, then the regular ones. A red dot starts ticked. */
function buildUpdateChoices(
  rows: EnhancedPackageInfo[],
): Array<{ name: string; value: string; checked: boolean } | Separator> {
  const makeChoice = (row: EnhancedPackageInfo) => {
    const devTag = row.isDev ? pc.dim(' (dev)') : '';
    const version = `${pc.red(row.current)} → ${pc.green(row.latest)}`;
    const notes = [
      row.breaking ? pc.bold('breaking') : '',
      row.runtime?.note ? pc.dim(row.runtime.note) : '',
      row.pinnedIn.length > 0 ? `${warningMark} ${pc.dim(`pinned in ${row.pinnedIn.join(', ')}`)}` : '',
    ].filter(Boolean);
    return {
      name: `${row.name}${devTag}  ${version}${notes.length > 0 ? `  ${notes.join('  ')}` : ''}`,
      value: row.key,
      checked: isRed(row),
    };
  };

  const runtimes = rows.filter((p) => p.runtime);
  const pinned = rows.filter((p) => !p.runtime && p.pinnedIn.length > 0);
  const regular = rows.filter((p) => !p.runtime && p.pinnedIn.length === 0);

  const choices: Array<{ name: string; value: string; checked: boolean } | Separator> = [];

  if (runtimes.length > 0) {
    choices.push(new Separator(pc.yellow(`── runtimes (${runtimes.length}) ──`)));
    choices.push(...runtimes.map(makeChoice));
  }
  if (pinned.length > 0) {
    choices.push(new Separator(pc.yellow(`── pinned (${pinned.length}) ──`)));
    choices.push(...pinned.map(makeChoice));
  }
  if (regular.length > 0) {
    if (choices.length > 0) choices.push(new Separator(pc.dim(`── packages (${regular.length}) ──`)));
    choices.push(...regular.map(makeChoice));
  }

  return choices;
}

/** The one prompt of the update step; null when it was cancelled. Submitting with nothing ticked skips the updates. */
async function promptForUpdates(rows: EnhancedPackageInfo[]): Promise<string[] | null> {
  try {
    const selected = await checkbox({
      message: `toggle what to update ${pc.dim('· enter with nothing ticked skips')}`,
      choices: buildUpdateChoices(rows),
      required: false,
      pageSize: 20,
      loop: false,
      theme: {
        icon: {
          cursor: '❯ ',
        },
        style: {
          highlight: (text: string) => text,
          keysHelpTip: (keys: [string, string][]) => {
            const tips = keys.map(([key, action]: [string, string]) => `${pc.dim(key)} ${action}`);
            return tips.join('  ');
          },
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
  if (update.pin.kind === 'node') return `engines.node ${update.target}`;
  if (update.pin.kind === 'pnpm') return `packageManager pnpm@${update.target}`;
  return update.pin.to;
}

/**
 * The selected updates as file contents, printed as one line per changed file. A dependency's
 * specifier keeps its prefix; one the audit cannot rewrite is left as written with a warning. A
 * Node bump waits until Docker Hub has every `node:<version><suffix>` image the Dockerfiles build from.
 */
async function planEdits(
  forkPath: string,
  rows: EnhancedPackageInfo[],
  selected: string[],
  nodeImageSuffixes: string[],
): Promise<{ edits: WorkspaceEdits; bumped: RuntimeUpdate[] }> {
  const contents = new Map<string, { content: string; resolves: boolean }>();
  const summary = new Map<string, string[]>();
  const bumped: RuntimeUpdate[] = [];
  const edit = (file: string, label: string, item: string, resolves: boolean, change: (content: string) => string) => {
    const entry = contents.get(file) ?? { content: readFileSync(join(forkPath, file), 'utf8'), resolves: false };
    const next = change(entry.content);
    if (next === entry.content) return;
    contents.set(file, { content: next, resolves: entry.resolves || resolves });
    summary.set(label, [...(summary.get(label) ?? []), item]);
  };

  const chosen = rows.filter((row) => selected.includes(row.key));
  for (const row of chosen) {
    if (row.runtime) continue;
    for (const { name: dependent, location } of row.dependentPackages) {
      const file = relative(forkPath, join(location, 'package.json'));
      edit(file, dependent || file, row.name, true, (content) =>
        editJsonText(content, (json) => {
          for (const section of DEPENDENCY_SECTIONS) {
            const deps = json[section] as Record<string, string> | undefined;
            const spec = deps?.[row.name];
            if (!deps || spec === undefined) continue;
            const next = rewriteSpecifier(spec, row.latest);
            if (next) deps[row.name] = next;
            else console.info(`${warningMark} ${row.name} in ${dependent || file} left as written: ${spec}`);
          }
        }),
      );
    }
  }

  for (const row of chosen) {
    const update = row.runtime;
    if (!update) continue;
    if (update.pin.kind === 'node') {
      const missing = await missingNodeImages(update.target, nodeImageSuffixes);
      if (missing.length > 0) {
        console.info(`${warningMark} node ${update.target} skipped: ${missing.join(', ')} is not on docker hub yet`);
        continue;
      }
    }
    edit(update.file, update.file, bumpText(update), false, (content) => applyRuntimeUpdate(content, update));
    bumped.push(update);
  }

  for (const [label, items] of summary) {
    console.info(`${pc.cyan('↑')} ${pc.bold(label)}: ${pc.dim(items.join(', '))}`);
  }
  if (summary.size > 0) console.info();

  const edits: WorkspaceEdits = { manifests: {}, files: {} };
  for (const [file, { content, resolves }] of contents) {
    (resolves ? edits.manifests : edits.files)[file] = content;
  }
  return { edits, bumped };
}

/** The steps a runtime bump leaves to the developer: this machine's Node, and a local build of each changed image. */
function printNext(bumped: RuntimeUpdate[]): void {
  const steps: Array<[command: string, why: string]> = [];
  const node = bumped.find((update) => update.pin.kind === 'node');
  if (node && process.version !== `v${node.target}`) {
    const command = getEnv('VOLTA_HOME') ? `volta install node@${node.target}` : `switch to node ${node.target}`;
    steps.push([command, `this machine runs ${process.version.slice(1)}`]);
  }
  for (const update of bumped) {
    if (update.pin.kind === 'image') steps.push([`docker build -f ${update.file} .`, 'check that the image builds']);
  }
  if (steps.length === 0) return;

  const width = Math.max(...steps.map(([command]) => command.length));
  console.info(pc.bold('next'));
  for (const [command, why] of steps) console.info(`  ${pc.dim('•')} ${command.padEnd(width)}   ${pc.dim(why)}`);
  console.info();
}
