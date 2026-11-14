import type { Command } from '../command';
import { withTestbed } from '../testbed';
import { toolDir } from '../utils/app';
import { requireChromium } from '../utils/drive';
import { type AuditOptions, runAudit } from './audit';
import { type DecideOptions, runDecide } from './decide';
import { runReport } from './report';
import { loadAppConfig, loadScope } from './scope';

type A11yOptions =
  | { job: 'audit'; audit: AuditOptions }
  | { job: 'report'; publish: boolean; draft: boolean }
  | { job: 'decide'; decide: DecideOptions };

const list = (value: unknown) => (typeof value === 'string' ? value.split(',').filter(Boolean) : []);
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function parseA11y({ job, opts }: { job: A11yOptions['job']; opts: Record<string, unknown> }): A11yOptions {
  if (job === 'report') return { job, publish: opts.publish === true, draft: opts.draft === true };
  if (job === 'decide') {
    const { file, ...decision } = opts;
    if (file !== undefined && Object.keys(decision).length > 0)
      throw new Error('--file holds the decisions: no other flags');
    return { job, decide: { file: text(file), decision: { ...decision, where: list(opts.where) } } };
  }
  const workers = opts.workers === undefined ? 4 : Number(opts.workers);
  if (!Number.isInteger(workers) || workers < 1) throw new Error('--workers takes a whole number, 1 or more');
  return { job, audit: { states: list(opts.states), workers, email: text(opts.email) } };
}

async function runA11y(repoRoot: string, options: A11yOptions): Promise<number> {
  const resultsDir = toolDir(repoRoot, 'a11y');
  if (options.job === 'decide') return runDecide(repoRoot, options.decide);
  if (options.job === 'report') return runReport(repoRoot, resultsDir, options);

  // Before the testbed starts: a scope that does not fit this CLI, or a missing browser, fails in seconds
  const scope = await loadScope(repoRoot);
  const unknown = options.audit.states.filter((id) => !scope.states.some((state) => state.id === id));
  if (unknown.length > 0) {
    throw new Error(`no state ${unknown.join(', ')} in the scope: ${scope.states.map((state) => state.id).join(', ')}`);
  }
  await requireChromium(repoRoot);
  const app = await loadAppConfig(repoRoot, 'development');
  return withTestbed(repoRoot, (testbed) => runAudit({ repoRoot, app, resultsDir }, scope, testbed, options.audit));
}

export const a11yCommand: Command<A11yOptions, A11yOptions['job']> = {
  name: 'a11y',
  group: 'develop',
  description: 'audit the app against WCAG 2.2 AA on a testbed and keep the conformance ledger',
  jobs: [
    ['audit', 'axe, browser probes and code checks on every state; writes cella/a11y-ledger.json'],
    ['report', 'render the ledger as a draft VPAT and the checklist for the manual pass'],
    ['decide', "record a reviewer's decisions with their evidence"],
  ],
  options: [
    ['--states <ids>', 'these states only, comma separated; writes ledger-partial.json, never the ledger', 'audit'],
    ['--workers <n>', 'states audited at the same time (default 4)', 'audit'],
    ['--email <address>', 'the audit user (default ADMIN_EMAIL in .env)', 'audit'],
    ['--publish', 'put the PDF where the app serves it and print what the statement needs', 'report'],
    ['--draft', 'publish while rows still need a person; the statement calls the results provisional', 'report'],
    ['--file <path>', 'a JSON list of decisions', 'decide'],
    ['--id <criterion>', 'the criterion, such as 2.4.6', 'decide'],
    ['--status <status>', 'supports, partially-supports, does-not-support, not-applicable or open', 'decide'],
    ['--by <reviewer>', 'agent or human', 'decide'],
    ['--remarks <text>', 'what the report tells its reader', 'decide'],
    ['--evidence <text>', 'what the reviewer looked at and found', 'decide'],
    ['--where <ids>', 'the states or files the finding is about, comma separated', 'decide'],
  ],
  parse: parseA11y,
  run: runA11y,
};
