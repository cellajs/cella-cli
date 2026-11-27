import { commandTitle } from '../../utils/display';
import { terminalColumns, visibleWidth } from '../../utils/layout';
import { commitRefs } from '../lib/deploy/git-remote';
import { commitName, type RemoteRef } from '../lib/deploy/target';
import type { EngineConfig } from '../lib/engine-config';
import type { KeyPair } from '../lib/scaleway/operator-identity';
import type { StackState } from '../lib/stack/bootstrap-stack-state';
import { nameSubject, rowText } from '../lib/status/check';
import { checkGroups, groupOf } from '../lib/status/registry';
import { buildReport } from '../lib/status/session';
import type { Check, CheckStatus, StatusReport } from '../lib/status/types';
import { checkMark, crossMark, divider, pc, warningMark, withSpinner } from '../lib/utils/cli-output';
import { inMenuSession } from './session';

const marks: Record<CheckStatus, string> = { ok: checkMark, warn: warningMark, missing: crossMark, error: crossMark, unknown: pc.dim('?') };

/** The mark a status row starts with. */
export function markOf(status: CheckStatus): string {
  return marks[status];
}

/** Where a row's detail starts: the mark, a space, the label padded to 12, a space. */
const detailColumn = 15;
const indent = ' '.repeat(detailColumn);

/** One status row: mark, bold label padded to the detail column, detail. A detail wider than the terminal wraps at a word under itself. */
export function statusRow(mark: string, label: string, detail: string): string {
  const [first = '', ...rest] = fill(detail.split(' '), ' ');
  return [`${mark} ${pc.bold(label.padEnd(detailColumn - 3))} ${first}`, ...rest.map((line) => `${indent}${line}`)].join('\n');
}

/** A row whose detail runs on: its first line beside the label, the others under it at the detail column. */
export function statusRows(mark: string, label: string, lines: readonly string[]): string[] {
  return lines.map((line, index) => (index === 0 ? statusRow(mark, label, line) : `${indent}${line}`));
}

/** Parts joined by `separator` into lines of at most `width` visible columns, the terminal's beside the detail column, a part never split. */
export function fill(parts: readonly string[], separator: string, width = terminalColumns() - detailColumn): string[] {
  const lines: string[] = [];
  for (const part of parts) {
    const last = lines.at(-1);
    if (last !== undefined && visibleWidth(`${last}${separator}${part}`) <= width) lines[lines.length - 1] = `${last}${separator}${part}`;
    else lines.push(part);
  }
  return lines;
}

/** The items a finding names, one per line at the detail column, in columns: the first plain, the others dim. */
function itemLines(items: readonly string[][]): string[] {
  const widths: number[] = [];
  for (const item of items) for (const [index, cell] of item.entries()) widths[index] = Math.max(widths[index] ?? 0, cell.length);
  return items.map(([first = '', ...rest]) => {
    const cells = rest.map((cell, index) => (index < rest.length - 1 ? cell.padEnd(widths[index + 1] ?? 0) : cell));
    return `${indent}${cells.length > 0 ? `${first.padEnd(widths[0] ?? 0)}  ${pc.dim(cells.join('  '))}` : first}`;
  });
}

/**
 * A check's row; one that needs a person adds the items it names, or the detail its headline shortens, and what fixes it: the next
 * action's words in a menu session, its command in a run without the menu.
 */
export function checkLines(check: Check, refs?: readonly RemoteRef[]): string[] {
  const lines = [statusRow(marks[check.status], check.title, rowText(check, refs))];
  if (check.status === 'ok' || check.status === 'unknown') return lines;
  if (check.items?.length) lines.push(...itemLines(check.items));
  else if (check.headline) lines.push(...fill(nameSubject(check, refs).split(' '), ' ').map((line) => `${indent}${pc.dim(line)}`));
  const next = inMenuSession() ? check.nextAction?.description : check.nextAction && pc.cyan(check.nextAction.command);
  const fixes = [check.fix, next].flatMap((fix) => (fix ? fill(fix.split(' '), ' ', terminalColumns() - detailColumn - 5) : []));
  lines.push(...fixes.map((line, index) => `${indent}${index === 0 ? pc.bold('Fix') : '   '}  ${line}`));
  return lines;
}

/** The ok checks, one line per group: each check's headline or detail once, the services that serve one release counted as one phrase. */
function okLines(checks: readonly Check[], refs?: readonly RemoteRef[]): string[] {
  const phrases = new Map<string, Set<string>>();
  const services = checks.filter((check) => check.id.startsWith('live.') && check.id !== 'live.components');
  const served = new Set(services.map((check) => (check.subject ? commitName(refs, check.subject) : rowText(check, refs))));
  const servedOne = `${services.length} service${services.length === 1 ? ' serves' : 's serve'} ${[...served][0]}`;
  const rank = (check: Check) => groupOf(check.id)?.rank ?? Number.MAX_SAFE_INTEGER;
  for (const check of [...checks].sort((a, b) => rank(a) - rank(b))) {
    const group = groupOf(check.id)?.label ?? 'Other';
    const phrase = served.size === 1 && services.includes(check) ? servedOne : rowText(check, refs);
    phrases.set(group, (phrases.get(group) ?? new Set()).add(phrase));
  }
  return [...checkGroups, 'Other'].flatMap((group) => {
    const parts = phrases.get(group);
    return parts ? statusRows(checkMark, group, fill([...parts], ' · ')) : [];
  });
}

/**
 * The full status: a title under the header's rule, then what needs a person (each finding with its items and its fix), what could not
 * be read, and the ok checks folded into one line per group.
 */
export function formatReport(report: StatusReport, refs?: readonly RemoteRef[]): string {
  const lines = [commandTitle('infra', 'status'), divider];
  const toFix = report.checks.filter((check) => check.status !== 'ok' && check.status !== 'unknown');
  const unknown = report.checks.filter((check) => check.status === 'unknown');
  if (toFix.length > 0)
    lines.push('', pc.bold('To fix'), ...toFix.flatMap((check, index) => [...(index > 0 ? [''] : []), ...checkLines(check, refs)]));
  if (unknown.length > 0) lines.push('', pc.bold('Not read'), ...unknown.flatMap((check) => checkLines(check, refs)));
  const ok = report.checks.filter((check) => check.status === 'ok');
  if (ok.length > 0) lines.push('', pc.bold('OK'), ...okLines(ok, refs));
  return lines.join('\n');
}

/** Menu entry: report status for an already-loaded CLI context. */
export async function runStatus(context: {
  environment: string;
  appConfig: EngineConfig;
  state: StackState;
  stackYaml?: string;
  projectId: string;
  operatorKey?: KeyPair;
}): Promise<void> {
  const recent = recentReport(context.environment);
  const report =
    recent ??
    (await withSpinner(`Checking ${context.environment}`, () =>
      buildReport({
        mode: context.environment,
        appConfig: context.appConfig,
        stackState: context.state,
        stackYaml: context.stackYaml,
        projectId: context.projectId || undefined,
        operatorKey: context.operatorKey,
      }),
    ));
  console.info(formatReport(report, await commitRefs()));
}

/** How long a report the home screen read serves the full table too: one key after the home does not read everything again. */
const reportFreshMs = 120_000;

let lastReport: StatusReport | undefined;

/** Keep the report the home screen read, for a full status asked right after. */
export function rememberReport(report: StatusReport): void {
  lastReport = report;
}

/** The remembered report of a mode while it is fresh. */
function recentReport(mode: string): StatusReport | undefined {
  if (!lastReport || lastReport.mode !== mode || Date.now() - Date.parse(lastReport.generatedAt) > reportFreshMs) return undefined;
  return lastReport;
}

/** The inventory alone (`inventory.*`), as `rotate-keys` prints it at its end: what remains beside the declared identities and machines. */
export async function printInventory(context: Parameters<typeof runStatus>[0]): Promise<void> {
  const report = await buildReport({
    mode: context.environment,
    appConfig: context.appConfig,
    stackState: context.state,
    stackYaml: context.stackYaml,
    projectId: context.projectId || undefined,
    operatorKey: context.operatorKey,
  });
  const inventory = report.checks.filter((check) => check.id.startsWith('inventory.'));
  console.info(`\n${pc.bold('Inventory')} ${pc.dim('(what exists beside what the environment declares)')}`);
  for (const check of inventory) for (const line of checkLines(check)) console.info(line);
}
