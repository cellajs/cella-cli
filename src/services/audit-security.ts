/**
 * The security pass of the audit service. Audit overrides are derived data: every run drops them,
 * resolves the workspace without them in a staging copy, and puts back only what a current
 * advisory still needs. The workspace itself changes once, at the end, when the staged result
 * differs from what is there.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { confirm, select } from '@inquirer/prompts';
import {
  fetchPublishTimes,
  formatDependents,
  getVulnIcon,
  middleTruncate,
  runPnpm,
  runPnpmAudit,
  runPnpmJson,
} from '../utils/audit-utils';
import pc from '../utils/colors';
import { checkMark, createSpinner, DIVIDER, spinnerText, warningMark } from '../utils/display';
import {
  type Advisory,
  advisoriesFromAudit,
  isAuditOverride,
  liveExcludes,
  overrideModule,
  type PublishTimes,
  parseVersionedExclude,
  planSecurity,
  type SecurityItem,
  standingOverrides,
} from '../utils/security-plan';
import { type AuditSettings, readAuditSettings, readPatchFiles, writeAuditSettings } from '../utils/workspace-yaml';

const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const LOCK_FILE = 'pnpm-lock.yaml';

/** Root files, next to the manifests, that decide how pnpm resolves. */
const RESOLUTION_FILES = ['package.json', LOCK_FILE, '.npmrc', '.pnpmfile.cjs'];

/** What happens to an item: an override is written, its advisories are ignored, or it stays reported. */
type Action = 'override' | 'ignore' | 'open';

interface Decision {
  item: SecurityItem;
  action: Action;
  /** A release-age exclude that lets a fix younger than the release age install. */
  exclude?: string;
}

const readOr = (path: string, fallback = ''): string => (existsSync(path) ? readFileSync(path, 'utf8') : fallback);

const count = (n: number, noun: string, plural = `${noun}s`): string => `${n} ${n === 1 ? noun : plural}`;

const isBreaking = (item: SecurityItem): boolean => item.remedy.kind !== 'none' && item.remedy.breaking;

/**
 * Whether a developer decides about the item: it is new, and its fix is missing, too young, a
 * breaking jump, or for a package a workspace depends on directly (its manifest sets that version).
 */
const needsDecision = (item: SecurityItem): boolean =>
  item.standing === 'new' && (item.remedy.kind !== 'override' || item.remedy.breaking || item.direct);

const sameEntries = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);

/**
 * A copy of everything pnpm reads to resolve the workspace: manifests, lockfile, pnpm config and
 * patch files. Resolving there leaves the workspace and its node_modules alone.
 */
async function createStaging(forkPath: string, workspaceYaml: string): Promise<string> {
  const staging = mkdtempSync(join(tmpdir(), 'cella-audit-'));
  const projects = ((await runPnpmJson(['ls', '-r', '--depth', '-1', '--json'], forkPath)) ?? []) as Array<{
    path: string;
  }>;
  const files = [
    ...RESOLUTION_FILES,
    ...readPatchFiles(workspaceYaml),
    ...projects.map((project) => join(relative(forkPath, project.path), 'package.json')),
  ];
  for (const file of new Set(files)) {
    if (file.startsWith('..') || !existsSync(join(forkPath, file))) continue;
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    cpSync(join(forkPath, file), join(staging, file));
  }
  return staging;
}

/** Resolve the staging copy under `settings`; returns the lockfile, or pnpm's output on failure. */
async function resolveStaging(
  staging: string,
  workspaceYaml: string,
  settings: AuditSettings,
): Promise<{ lock: string } | { error: string }> {
  writeFileSync(join(staging, WORKSPACE_FILE), writeAuditSettings(workspaceYaml, settings));
  const result = await runPnpm(['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'], staging);
  return result.ok ? { lock: readOr(join(staging, LOCK_FILE)) } : { error: `${result.stdout}${result.stderr}`.trim() };
}

/** The versions of a package that a lockfile holds. */
function lockedVersions(lock: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const versions = [...lock.matchAll(new RegExp(`^ {2}'?${escaped}@(\\d[^:'()\\s]*)`, 'gm'))].map((match) => match[1]);
  return [...new Set(versions)];
}

/** `installed → fix`, flagged when the fix is a breaking jump; the installed version alone without a fix. */
function versionsText(item: SecurityItem): string {
  if (item.remedy.kind === 'none') return item.installed;
  return `${item.installed} → ${item.remedy.target}${isBreaking(item) ? ' ⚠' : ''}`;
}

/** One line of context for an item that is not simply fixed by its override. */
function noteText(item: SecurityItem, releaseAgeHours: number): string {
  if (item.remedy.kind === 'none') return 'no fix published';
  if (item.remedy.kind === 'fresh')
    return `fix published ${item.remedy.hoursOld}h ago, inside the ${releaseAgeHours}h release age`;
  if (item.standing === 'ignored') return 'the fix is a breaking jump';
  return '';
}

function printGroup(title: string, items: SecurityItem[], releaseAgeHours: number): void {
  if (items.length === 0) return;
  const nameWidth = Math.min(30, Math.max(...items.map((item) => item.module.length)));
  const versionWidth = Math.max(...items.map((item) => versionsText(item).length));

  console.info(pc.bold(`${title} (${items.length})`));
  for (const item of items) {
    const name = pc.white(middleTruncate(item.module, nameWidth).padEnd(nameWidth));
    const source = `${formatDependents(item.via)}${item.direct ? ' (direct)' : ''}`;
    const tail = [source, noteText(item, releaseAgeHours)].filter(Boolean).join(' · ');
    console.info(
      `${getVulnIcon(item.severity)} ${name}  ${item.severity.padEnd(8)}  ${versionsText(item).padEnd(versionWidth)}  ${pc.dim(tail)}`,
    );
  }
  console.info();
}

function printDropped(title: string, rows: Array<[name: string, reason: string]>): void {
  if (rows.length === 0) return;
  const nameWidth = Math.min(40, Math.max(...rows.map(([name]) => name.length)));
  console.info(pc.bold(`${title} (${rows.length})`));
  for (const [name, reason] of rows) {
    console.info(`${pc.green('○')} ${pc.white(middleTruncate(name, nameWidth).padEnd(nameWidth))}  ${pc.dim(reason)}`);
  }
  console.info();
}

/** Why an audit override from before the run is not coming back. */
function droppedReason(key: string, items: SecurityItem[], bareLock: string): string {
  const module = overrideModule(key);
  const item = items.find((candidate) => candidate.module === module);
  if (item) return item.remedy.kind === 'none' ? 'no published version fixes it' : 'replaced by another range';
  const versions = lockedVersions(bareLock, module);
  return versions.length > 0 ? `resolves to ${versions.join(', ')} on its own` : 'no longer installed';
}

/** Ask about the items that need a decision; everything else follows from its standing. */
async function decide(items: SecurityItem[], releaseAgeHours: number): Promise<Decision[]> {
  const decisions: Decision[] = [];

  for (const item of items) {
    const { remedy } = item;
    const jump = remedy.kind === 'none' ? '' : `${item.installed} → ${remedy.target}`;

    if (!needsDecision(item)) {
      decisions.push({ item, action: item.standing === 'ignored' ? 'ignore' : 'override' });
    } else if (remedy.kind === 'none') {
      const ignore = await confirm({
        message: `${item.module}: no fix is published. ignore ${item.ghsas.join(', ')} until one is?`,
        default: true,
      });
      decisions.push({ item, action: ignore ? 'ignore' : 'open' });
    } else if (remedy.kind === 'fresh') {
      const action = await select<Action>({
        message: `${item.module}: fix ${remedy.target} was published ${remedy.hoursOld}h ago, inside the ${releaseAgeHours}h release age`,
        choices: [
          { name: 'wait and re-run later', value: 'open' },
          { name: 'install now, with an exclude that a later audit removes', value: 'override' },
        ],
      });
      decisions.push({ item, action, exclude: action === 'override' ? `${item.module}@${remedy.target}` : undefined });
    } else {
      const message = item.direct
        ? `the fix is ${jump}, and ${item.via[0]} depends on it directly`
        : `the fix jumps ${jump}, past what ${formatDependents(item.via)} asks for`;
      const action = await select<Action>({
        message: `${item.module}: ${message}`,
        choices: [
          { name: item.direct ? 'leave open, update it in package.json' : 'leave open', value: 'open' },
          { name: 'apply the override', value: 'override' },
          { name: 'ignore the advisory', value: 'ignore' },
        ],
      });
      decisions.push({ item, action });
    }
  }

  return decisions;
}

/**
 * The settings that carry out the decisions, on top of `kept`: the overrides the audit does not
 * own, plus the ones a package had before when its item is left open.
 */
function settingsFor(decisions: Decision[], kept: Record<string, string>, excludes: string[]): AuditSettings {
  const overriding = decisions.filter((decision) => decision.action === 'override');
  return {
    overrides: { ...kept, ...Object.assign({}, ...overriding.map((decision) => decision.item.overrides)) },
    releaseAgeExcludes: [...new Set([...excludes, ...overriding.flatMap((decision) => decision.exclude ?? [])])],
    ignoredGhsas: decisions
      .filter((decision) => decision.action === 'ignore')
      .flatMap((decision) => decision.item.ghsas),
  };
}

/** `before → after` with what moved, or the count alone when nothing did. */
function changeLine(label: string, before: string[], after: string[]): string {
  const dropped = before.filter((entry) => !after.includes(entry)).length;
  const added = after.filter((entry) => !before.includes(entry)).length;
  const moved = [dropped ? `${dropped} dropped` : '', added ? `${added} added` : ''].filter(Boolean).join(', ');
  const counts = moved ? `${before.length} → ${after.length}` : String(after.length);
  return `  ${label.padEnd(9)}  ${counts.padEnd(7)}  ${pc.dim(moved || 'unchanged')}`;
}

/**
 * Run the security pass on the workspace at `forkPath`. With `apply` off it reports what it would
 * do and writes nothing.
 */
export async function runSecurityPass(forkPath: string, options: { apply: boolean }): Promise<void> {
  const workspaceYaml = readOr(join(forkPath, WORKSPACE_FILE));
  const workspaceLock = readOr(join(forkPath, LOCK_FILE));
  let previous: AuditSettings;
  try {
    previous = readAuditSettings(workspaceYaml);
  } catch (error) {
    console.error(
      `${pc.red('✗')} ${WORKSPACE_FILE} could not be read: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }
  const auditKeys = Object.keys(previous.overrides).filter(isAuditOverride);
  const lasting = Object.fromEntries(Object.entries(previous.overrides).filter(([key]) => !isAuditOverride(key)));

  const spinner = createSpinner(
    auditKeys.length > 0
      ? `resolving without the ${count(auditKeys.length, 'audit override')}...`
      : 'resolving the workspace...',
  );
  const fail = (message: string, detail = ''): void => {
    spinner.stop();
    console.error(`${pc.red('✗')} ${message}`);
    if (detail) console.error(pc.dim(detail.split('\n').slice(-12).join('\n')));
    console.info(pc.dim('  the workspace is unchanged'));
    console.info();
  };

  const staging = await createStaging(forkPath, workspaceYaml);
  try {
    // Ignores come off as well, so an ignored advisory is seen again and can pick up a fix.
    const bare = await resolveStaging(staging, workspaceYaml, { ...previous, overrides: lasting, ignoredGhsas: [] });
    if ('error' in bare) return fail('could not resolve the workspace without its audit overrides', bare.error);

    spinnerText('checking for vulnerabilities...');
    const audit = await runPnpmAudit(staging);
    if (!audit) return fail('pnpm audit gave no answer, so nothing can be decided');
    const advisories = advisoriesFromAudit(audit);

    spinnerText(`checking ${count(advisories.length, 'advisory', 'advisories')} against the registry...`);
    const versionedExcludes = previous.releaseAgeExcludes.flatMap((entry) => parseVersionedExclude(entry)?.name ?? []);
    const names = [...new Set([...advisories.map((advisory) => advisory.module), ...versionedExcludes])];
    const times = await Promise.all(names.map((name) => fetchPublishTimes(name, forkPath)));
    const published: Record<string, PublishTimes> = Object.fromEntries(
      names.map((name, i) => [name, times[i]]).filter(([, answer]) => answer),
    );
    // A fix is only judged absent when the registry answered: silence must not turn into an ignore.
    const unanswered = advisories.map((advisory) => advisory.module).filter((name) => !published[name]);
    if (unanswered.length > 0) return fail(`the registry did not answer for ${[...new Set(unanswered)].join(', ')}`);

    const releaseAge = Number.parseInt((await runPnpm(['config', 'get', 'minimumReleaseAge'], forkPath)).stdout, 10);
    const releaseAgeMinutes = Number.isNaN(releaseAge) ? 0 : releaseAge;
    const releaseAgeHours = Math.round(releaseAgeMinutes / 60);
    const planInput = { advisories, published, previous, releaseAgeMinutes, now: Date.now() };
    const items = planSecurity(planInput);
    const excludes = liveExcludes(planInput);
    spinner.stop();

    const changes = printPlan({
      items,
      previous,
      auditKeys,
      lasting,
      advisories,
      bareLock: bare.lock,
      releaseAgeHours,
    });
    if (!options.apply) {
      if (changes) console.info(pc.dim('run without --list to apply'));
      console.info();
      return;
    }

    let decisions: Decision[];
    try {
      decisions = await decide(items, releaseAgeHours);
    } catch {
      console.info(pc.dim('  cancelled, the workspace is unchanged'));
      return;
    }

    const open = decisions.filter((decision) => decision.action === 'open').map((decision) => decision.item.module);
    const kept = Object.assign({}, lasting, ...open.map((module) => standingOverrides(module, planInput)));
    const next = settingsFor(decisions, kept, excludes);
    const nextYaml = writeAuditSettings(workspaceYaml, next);

    if (nextYaml === workspaceYaml) {
      const state = `${count(auditKeys.length, 'override')} · ${next.ignoredGhsas.length} ignored`;
      console.info(`${checkMark} security settings are current ${pc.dim(`· ${state}`)}`);
      printOpen(open);
      return;
    }

    const summarize = (): void => {
      console.info(pc.bold(WORKSPACE_FILE));
      console.info(changeLine('overrides', auditKeys, Object.keys(next.overrides).filter(isAuditOverride)));
      console.info(changeLine('excludes', previous.releaseAgeExcludes, next.releaseAgeExcludes));
      console.info(changeLine('ignored', previous.ignoredGhsas, next.ignoredGhsas));
      console.info();
    };

    // Ignores and aged excludes do not change what resolves: the file is all there is to write.
    if (sameEntries(next.overrides, previous.overrides)) {
      writeFileSync(join(forkPath, WORKSPACE_FILE), nextYaml);
      console.info(`${checkMark} ${WORKSPACE_FILE} updated ${pc.dim('· nothing to install')}`);
      printOpen(open);
      summarize();
      return;
    }

    const stagingSpinner = createSpinner('resolving with the new settings...');
    const staged = await resolveStaging(staging, workspaceYaml, next);
    stagingSpinner.stop();
    if ('error' in staged) return fail('could not resolve the workspace with the new settings', staged.error);

    writeFileSync(join(forkPath, WORKSPACE_FILE), nextYaml);
    writeFileSync(join(forkPath, LOCK_FILE), staged.lock);
    const install = spawnSync('pnpm', ['install'], { cwd: forkPath, stdio: 'inherit' });
    console.info();
    if (install.status !== 0) {
      writeFileSync(join(forkPath, WORKSPACE_FILE), workspaceYaml);
      writeFileSync(join(forkPath, LOCK_FILE), workspaceLock);
      console.error(`${pc.red('✗')} pnpm install failed (exit code ${install.status})`);
      console.info(pc.dim(`  ${WORKSPACE_FILE} and ${LOCK_FILE} are back as they were; run pnpm install to match`));
      console.info();
      return;
    }

    // The workspace's own audit has the last word on what is still reported.
    const verified = await runPnpmAudit(forkPath);
    const reported = verified ? [...new Set(advisoriesFromAudit(verified).map((advisory) => advisory.module))] : open;
    console.info(`${checkMark} installed${reported.length === 0 ? ` ${pc.dim('·')} audit clean` : ''}`);
    printOpen(reported);

    summarize();
  } finally {
    spinner.stop();
    rmSync(staging, { recursive: true, force: true });
  }
}

function printOpen(modules: string[]): void {
  if (modules.length > 0) {
    console.info(`${warningMark} ${count(modules.length, 'package')} still reported: ${modules.join(', ')}`);
  }
  console.info();
}

/** The report of the staged audit: what stays, what is new, what goes. Returns whether a run would change anything. */
function printPlan(plan: {
  items: SecurityItem[];
  previous: AuditSettings;
  auditKeys: string[];
  lasting: Record<string, string>;
  advisories: Advisory[];
  bareLock: string;
  releaseAgeHours: number;
}): boolean {
  const { items, previous, releaseAgeHours } = plan;
  const kept = items.filter((item) => item.standing === 'carried');
  const undecided = items.filter(needsDecision);
  const added = items.filter((item) => item.standing === 'new' && !needsDecision(item));
  const ignored = items.filter((item) => item.standing === 'ignored');

  const plannedKeys = new Set(
    items.flatMap((item) => (item.standing === 'ignored' ? [] : Object.keys(item.overrides))),
  );
  // What happens to the overrides of a package that awaits a decision follows from the answer.
  const pending = new Set(undecided.map((item) => item.module));
  const droppedOverrides = plan.auditKeys
    .filter((key) => !plannedKeys.has(key) && !pending.has(overrideModule(key)))
    .map((key): [string, string] => [key, droppedReason(key, items, plan.bareLock)]);

  const reportedGhsas = new Set(plan.advisories.map((advisory) => advisory.ghsa));
  const fixedGhsas = new Set([...kept, ...added].flatMap((item) => item.ghsas));
  const droppedIgnores = previous.ignoredGhsas
    .filter((ghsa) => !reportedGhsas.has(ghsa) || fixedGhsas.has(ghsa))
    .map((ghsa): [string, string] => [ghsa, fixedGhsas.has(ghsa) ? 'a fix is published' : 'no longer applies']);

  console.info(pc.bold('security'));
  console.info(DIVIDER);
  if (items.length === 0 && droppedOverrides.length === 0 && droppedIgnores.length === 0) {
    console.info(`${checkMark} no vulnerabilities found`);
    console.info();
    return false;
  }

  printGroup('override kept', kept, releaseAgeHours);
  printGroup('fix available', added, releaseAgeHours);
  printGroup('needs a decision', undecided, releaseAgeHours);
  printGroup('ignored', ignored, releaseAgeHours);
  printDropped('override dropped', droppedOverrides);
  printDropped('ignore dropped', droppedIgnores);

  const lastingCount = Object.keys(plan.lasting).length;
  if (lastingCount > 0) {
    console.info(pc.dim(`${count(lastingCount, 'override')} without a version selector left as written`));
  }
  if (items.some(isBreaking)) {
    console.info(pc.dim('⚠ a breaking jump: another major, or another minor below 1.0'));
  }
  console.info();
  return added.length + undecided.length + droppedOverrides.length + droppedIgnores.length > 0;
}
