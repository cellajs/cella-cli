import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import select from '@inquirer/select';
import semver from 'semver';
import pc from '../utils/colors';
import { checkMark, createSpinner, divider, plural, spinnerText, warningMark } from '../utils/display';
import { fetchPublishTimes, runPnpm, runPnpmAudit, runPnpmJson } from '../utils/pnpm';
import { confirm } from '../utils/prompts';
import { type AuditSettings, readAuditSettings, readPatchFiles, writeAuditSettings } from '../utils/workspace-yaml';
import { formatDependents, installedVerdict, middleTruncate, printAdvisoryRows } from './format';
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
} from './security-plan';

const workspaceFile = 'pnpm-workspace.yaml';
const lockFile = 'pnpm-lock.yaml';

/** Root files, next to the manifests, that decide how pnpm resolves. */
const resolutionFiles = ['package.json', lockFile, '.npmrc', '.pnpmfile.cjs'];

/** What happens to an item: an override is written, its advisories are ignored, or it stays reported. */
type Action = 'override' | 'ignore' | 'open';

interface Decision {
  item: SecurityItem;
  action: Action;
  /** A release-age exclude that lets a fix younger than the release age install. */
  exclude?: string;
}

const readOr = <T>(path: string, fallback: T): string | T => (existsSync(path) ? readFileSync(path, 'utf8') : fallback);

const isBreaking = (item: SecurityItem): boolean => item.remedy.type !== 'none' && item.remedy.breaking;

/**
 * Whether a developer decides about the item: it is new, and its fix is missing, too young, a
 * breaking jump, or for a package a workspace depends on directly (its manifest sets that version).
 */
const needsDecision = (item: SecurityItem): boolean =>
  item.standing === 'new' && (item.remedy.type !== 'override' || item.remedy.breaking || item.direct);

const sameEntries = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);

/**
 * A copy of everything pnpm reads to resolve the workspace: manifests, lockfile, pnpm config and
 * patch files. Resolving there leaves the workspace and its node_modules alone.
 */
async function createStaging(repoRoot: string, workspaceYaml: string): Promise<string> {
  const staging = mkdtempSync(join(tmpdir(), 'cella-audit-'));
  const projects = ((await runPnpmJson(['ls', '-r', '--depth', '-1', '--json'], repoRoot)) ?? []) as Array<{
    path: string;
  }>;
  const files = [
    ...resolutionFiles,
    ...readPatchFiles(workspaceYaml),
    ...projects.map((project) => join(relative(repoRoot, project.path), 'package.json')),
  ];
  for (const file of new Set(files)) {
    if (file.startsWith('..') || !existsSync(join(repoRoot, file))) continue;
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(staging, file));
  }
  return staging;
}

/** Resolve the staging copy under `settings`; returns the lockfile, or pnpm's output on failure. */
async function resolveStaging(staging: string, workspaceYaml: string, settings: AuditSettings): Promise<{ lock: string } | { error: string }> {
  writeFileSync(join(staging, workspaceFile), writeAuditSettings(workspaceYaml, settings));
  const result = await runPnpm(['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'], staging);
  return result.ok ? { lock: readOr(join(staging, lockFile), '') } : { error: `${result.stdout}${result.stderr}`.trim() };
}

/** The versions of a package that a lockfile holds. */
function lockedVersions(lock: string, name: string): string[] {
  const versions = [...lock.matchAll(new RegExp(`^ {2}'?${RegExp.escape(name)}@(\\d[^:'()\\s]*)`, 'gm'))].map((match) => match[1]);
  return [...new Set(versions)];
}

/**
 * `installed → fix`, flagged when the fix is a breaking jump; the installed version alone without a
 * fix. A package an override fixes shows what `lock` holds, next to what resolves without the override.
 */
function versionsText(item: SecurityItem, lock: string): string {
  if (item.remedy.type === 'none') return item.installed;
  const mark = isBreaking(item) ? ' ⚠' : '';
  if (item.standing !== 'carried') return `${item.installed} → ${item.remedy.target}${mark}`;
  const targets = Object.values(item.overrides);
  const held = lockedVersions(lock, item.module).filter((v) => targets.some((target) => semver.satisfies(v, target)));
  return `${held.join(', ') || item.remedy.target}${mark} (${item.installed} without it)`;
}

/** One line of context for an item that is not simply fixed by its override. */
function noteText(item: SecurityItem, releaseAgeHours: number): string {
  if (item.remedy.type === 'none') return 'no fix published';
  if (item.remedy.type === 'fresh') return `fix published ${item.remedy.hoursOld}h ago, inside the ${releaseAgeHours}h release age`;
  if (item.standing === 'ignored') return 'the fix is a breaking jump';
  return '';
}

function printGroup(title: string, items: SecurityItem[], lock: string, releaseAgeHours: number): void {
  printAdvisoryRows(
    pc.bold(`${title} (${items.length})`),
    items.map((item) => ({
      module: item.module,
      severity: item.severity,
      versions: versionsText(item, lock),
      note: [`${formatDependents(item.via)}${item.direct ? ' (direct)' : ''}`, noteText(item, releaseAgeHours)].filter(Boolean).join(' · '),
    })),
  );
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
  if (item) return item.remedy.type === 'none' ? 'no published version fixes it' : 'replaced by another range';
  const versions = lockedVersions(bareLock, module);
  return versions.length > 0 ? `resolves to ${versions.join(', ')} on its own` : 'no longer installed';
}

/** Ask about the items that need a decision; everything else follows from its standing. */
async function decide(items: SecurityItem[], releaseAgeHours: number): Promise<Decision[]> {
  const decisions: Decision[] = [];

  for (const item of items) {
    const { remedy } = item;
    const jump = remedy.type === 'none' ? '' : `${item.installed} → ${remedy.target}`;

    if (!needsDecision(item)) {
      decisions.push({ item, action: item.standing === 'ignored' ? 'ignore' : 'override' });
    } else if (remedy.type === 'none') {
      const ignore = await confirm({
        message: `${item.module}: no fix is published. ignore ${item.ghsas.join(', ')} until one is?`,
        default: true,
      });
      decisions.push({ item, action: ignore ? 'ignore' : 'open' });
    } else if (remedy.type === 'fresh') {
      const action = await select<Action>({
        message: `${item.module}: fix ${remedy.target} was published ${remedy.hoursOld}h ago, inside the ${releaseAgeHours}h release age`,
        choices: [
          { name: 'wait and re-run later', value: 'open' },
          { name: 'install now, with an exclude that a later audit removes', value: 'override' },
        ],
        theme: { style: { keysHelpTip: () => '' } },
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
        theme: { style: { keysHelpTip: () => '' } },
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
    ignoredGhsas: decisions.filter((decision) => decision.action === 'ignore').flatMap((decision) => decision.item.ghsas),
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

/** Files the update step changed, written by the security pass together with its own settings. */
export interface WorkspaceEdits {
  /** Manifests whose dependencies changed, by path from the workspace root: staged before the resolve. */
  manifests: Record<string, string>;
  /** Other files, such as runtime pins: written as they are, with nothing to resolve. */
  files: Record<string, string>;
}

const noEdits: WorkspaceEdits = { manifests: {}, files: {} };

/** Whether the edits landed; a report and a cancelled prompt leave the workspace as it was, and so does a failure. */
export type SecurityPassOutcome = 'written' | 'unchanged' | 'failed';

/**
 * Write `files` into the workspace, then run `pnpm install` when `install` is set. A failed install
 * puts every file back and removes one that did not exist before. Returns whether it succeeded.
 */
function writeWorkspace(repoRoot: string, files: Record<string, string>, install: boolean): boolean {
  const before = Object.fromEntries(Object.keys(files).map((file) => [file, readOr(join(repoRoot, file), undefined)] as const));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(repoRoot, file), content);
  if (!install) return true;

  const result = spawnSync('pnpm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
  console.info();
  if (result.status === 0) return true;
  for (const [file, content] of Object.entries(before)) {
    if (content === undefined) rmSync(join(repoRoot, file), { force: true });
    else writeFileSync(join(repoRoot, file), content);
  }
  console.error(`${pc.red('✗')} pnpm install failed (exit code ${result.status})`);
  console.info(pc.dim(`  ${Object.keys(before).join(', ')} are back as they were; run pnpm install to match`));
  console.info();
  return false;
}

/**
 * Run the audit's security pass on the workspace at `repoRoot`. The update step's `edits` are already in
 * place in the staging copy: the plan judges the workspace as it will be. Audit overrides are derived
 * data: every run drops them, resolves the workspace without them in the staging copy, and puts back only
 * what a current advisory still needs. The workspace is written once, at the end, when the staged result
 * differs from what is there; with `apply` off nothing is written.
 */
export async function runSecurityPass(
  repoRoot: string,
  options: {
    apply: boolean;
    releaseAgeMinutes: number;
    edits?: WorkspaceEdits;
    /**
     * What pnpm audit reports on the workspace as installed, which opens the section: null when it
     * gave no answer, left out when the caller printed it already.
     */
    installed?: Advisory[] | null;
  },
): Promise<SecurityPassOutcome> {
  const { releaseAgeMinutes, edits = noEdits } = options;
  const workspaceYaml = readOr(join(repoRoot, workspaceFile), '');
  let previous: AuditSettings;
  try {
    previous = readAuditSettings(workspaceYaml);
  } catch (error) {
    console.error(`${pc.red('✗')} ${workspaceFile} could not be read: ${error instanceof Error ? error.message : error}`);
    return 'failed';
  }
  const auditKeys = Object.keys(previous.overrides).filter(isAuditOverride);
  const lasting = Object.fromEntries(Object.entries(previous.overrides).filter(([key]) => !isAuditOverride(key)));
  const updatesManifests = Object.keys(edits.manifests).length > 0;

  const spinner = createSpinner(
    auditKeys.length > 0 ? `resolving without the ${plural(auditKeys.length, 'audit override')}...` : 'resolving the workspace...',
  );
  const fail = (message: string, detail = ''): 'failed' => {
    spinner.stop();
    console.error(`${pc.red('✗')} ${message}`);
    if (detail) console.error(pc.dim(detail.split('\n').slice(-12).join('\n')));
    console.info(pc.dim('  the workspace is unchanged'));
    console.info();
    return 'failed';
  };

  const staging = await createStaging(repoRoot, workspaceYaml);
  try {
    for (const [file, content] of Object.entries(edits.manifests)) writeFileSync(join(staging, file), content);

    // Ignores come off as well, so an ignored advisory is seen again and can pick up a fix.
    const bare = await resolveStaging(staging, workspaceYaml, { ...previous, overrides: lasting, ignoredGhsas: [] });
    if ('error' in bare) {
      const without = updatesManifests ? 'with the selected updates' : 'without its audit overrides';
      return fail(`could not resolve the workspace ${without}`, bare.error);
    }

    spinnerText('checking for vulnerabilities...');
    const audit = await runPnpmAudit(staging);
    if (!audit) return fail('pnpm audit gave no answer, so nothing can be decided');
    const advisories = advisoriesFromAudit(audit);

    spinnerText(`checking ${plural(advisories.length, 'advisory', 'advisories')} against the registry...`);
    const versionedExcludes = previous.releaseAgeExcludes.flatMap((entry) => parseVersionedExclude(entry)?.name ?? []);
    const names = [...new Set([...advisories.map((advisory) => advisory.module), ...versionedExcludes])];
    const times = await Promise.all(names.map((name) => fetchPublishTimes(name, repoRoot)));
    const published: Record<string, PublishTimes> = Object.fromEntries(names.map((name, i) => [name, times[i]]).filter(([, answer]) => answer));
    // A fix is only judged absent when the registry answered: silence must not turn into an ignore.
    const unanswered = advisories.map((advisory) => advisory.module).filter((name) => !published[name]);
    if (unanswered.length > 0) return fail(`the registry did not answer for ${[...new Set(unanswered)].join(', ')}`);

    const releaseAgeHours = Math.round(releaseAgeMinutes / 60);
    const planInput = { advisories, published, previous, releaseAgeMinutes, now: Date.now() };
    const items = planSecurity(planInput);
    spinner.stop();

    const changes = printPlan({
      items,
      previous,
      auditKeys,
      lasting,
      advisories,
      bareLock: bare.lock,
      lock: readOr(join(repoRoot, lockFile), ''),
      installed: options.installed,
      releaseAgeHours,
    });
    if (!options.apply) {
      if (changes) console.info(pc.dim('`pnpm cella audit fix` applies it'));
      console.info();
      return 'unchanged';
    }

    let decisions: Decision[];
    try {
      decisions = await decide(items, releaseAgeHours);
    } catch {
      console.info(pc.dim('  cancelled, the workspace is unchanged'));
      return 'unchanged';
    }

    const open = decisions.filter((decision) => decision.action === 'open').map((decision) => decision.item.module);
    const kept = Object.assign({}, lasting, ...open.map((module) => standingOverrides(module, planInput)));
    const next = settingsFor(decisions, kept, liveExcludes(planInput));
    const nextYaml = writeAuditSettings(workspaceYaml, next);
    const settingsChanged = nextYaml !== workspaceYaml;
    // Ignores and aged excludes do not change what resolves: only new manifests or overrides need an install.
    const install = updatesManifests || !sameEntries(next.overrides, previous.overrides);
    const files: Record<string, string> = { ...edits.files, ...(settingsChanged && { [workspaceFile]: nextYaml }) };

    if (install) {
      const stagingSpinner = createSpinner('resolving with the new settings...');
      const staged = await resolveStaging(staging, workspaceYaml, next);
      stagingSpinner.stop();
      if ('error' in staged) return fail('could not resolve the workspace with the new settings', staged.error);
      Object.assign(files, edits.manifests, { [lockFile]: staged.lock });
    }
    if (!writeWorkspace(repoRoot, files, install)) return 'failed';

    let reported = open;
    if (install) {
      // The workspace's own audit has the last word on what is still reported.
      const verified = await runPnpmAudit(repoRoot);
      if (verified) reported = [...new Set(advisoriesFromAudit(verified).map((advisory) => advisory.module))];
      console.info(`${checkMark} installed${reported.length === 0 ? ` ${pc.dim('·')} audit clean` : ''}`);
    } else if (Object.keys(files).length > 0) {
      console.info(`${checkMark} ${Object.keys(files).join(', ')} updated ${pc.dim('· nothing to install')}`);
    }
    if (!settingsChanged) {
      const state = `${plural(auditKeys.length, 'override')} · ${next.ignoredGhsas.length} ignored`;
      console.info(`${checkMark} security settings are current ${pc.dim(`· ${state}`)}`);
    }
    printOpen(reported);

    if (settingsChanged) {
      console.info(pc.bold(workspaceFile));
      console.info(changeLine('overrides', auditKeys, Object.keys(next.overrides).filter(isAuditOverride)));
      console.info(changeLine('excludes', previous.releaseAgeExcludes, next.releaseAgeExcludes));
      console.info(changeLine('ignored', previous.ignoredGhsas, next.ignoredGhsas));
      console.info();
    }
    return 'written';
  } finally {
    spinner.stop();
    rmSync(staging, { recursive: true, force: true });
  }
}

function printOpen(modules: string[]): void {
  if (modules.length > 0) {
    console.info(`${warningMark} ${plural(modules.length, 'package')} still reported: ${modules.join(', ')}`);
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
  /** The workspace's own lockfile. */
  lock: string;
  installed?: Advisory[] | null;
  releaseAgeHours: number;
}): boolean {
  const { items, previous, lock, releaseAgeHours } = plan;
  const kept = items.filter((item) => item.standing === 'carried');
  const undecided = items.filter(needsDecision);
  const added = items.filter((item) => item.standing === 'new' && !needsDecision(item));
  const ignored = items.filter((item) => item.standing === 'ignored');

  const plannedKeys = new Set(items.flatMap((item) => (item.standing === 'ignored' ? [] : Object.keys(item.overrides))));
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
  console.info(divider);
  if (plan.installed !== undefined) {
    const note = [kept.length > 0 ? `${kept.length} fixed by an override` : '', ignored.length > 0 ? `${ignored.length} ignored` : '']
      .filter(Boolean)
      .join(' · ');
    const vulnerable = new Set(plan.installed?.map((advisory) => advisory.module)).size;
    console.info(plan.installed ? installedVerdict(vulnerable, note) : `${warningMark} installed: pnpm audit gave no answer`);
    console.info();
  }
  if (items.length === 0 && droppedOverrides.length === 0 && droppedIgnores.length === 0) {
    if (plan.installed === undefined) {
      console.info(`${checkMark} no vulnerabilities found`);
      console.info();
    }
    return false;
  }

  printGroup('fixed by an override', kept, lock, releaseAgeHours);
  printGroup('fix available', added, lock, releaseAgeHours);
  printGroup('needs a decision', undecided, lock, releaseAgeHours);
  printGroup('ignored', ignored, lock, releaseAgeHours);
  printDropped('override dropped', droppedOverrides);
  printDropped('ignore dropped', droppedIgnores);

  const lastingCount = Object.keys(plan.lasting).length;
  if (lastingCount > 0) {
    console.info(pc.dim(`${plural(lastingCount, 'override')} without a version selector left as written`));
  }
  if (items.some(isBreaking)) {
    console.info(pc.dim('⚠ a breaking jump: another major, or another minor below 1.0'));
  }
  console.info();
  return added.length + undecided.length + droppedOverrides.length + droppedIgnores.length > 0;
}
