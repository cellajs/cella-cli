import type { ToolCommand } from '../../config/types';
import { toolDir } from '../../utils/app-facts';
import { requireChromium } from '../drive';
import { withTestbed } from '../testbed';
import { type AuditOptions, runAudit } from './audit';
import { type DecideOptions, runDecide } from './decide';
import { runReport } from './report';
import { loadAppConfig, loadScope } from './scope';

type A11yOptions =
  | { job: 'audit'; audit: AuditOptions }
  | { job: 'report'; publish: boolean; draft: boolean }
  | { job: 'decide'; decide: DecideOptions };

const jobs = ['audit', 'report', 'decide'] as const;

/** The job each flag belongs to; a flag given to another job is refused, so it never goes unheeded. */
const flagJobs: Record<string, (typeof jobs)[number]> = {
  states: 'audit',
  workers: 'audit',
  email: 'audit',
  publish: 'report',
  draft: 'report',
  file: 'decide',
  id: 'decide',
  status: 'decide',
  by: 'decide',
  remarks: 'decide',
  evidence: 'decide',
  where: 'decide',
};

const list = (value: unknown) => (typeof value === 'string' ? value.split(',').filter(Boolean) : []);
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function parseA11y({ job = 'audit', opts }: { job?: string; opts: Record<string, unknown> }): A11yOptions {
  const known = jobs.find((name) => name === job);
  if (!known) throw new Error(`unknown job '${job}'. expected one of: ${jobs.join(', ')}`);
  for (const [name, value] of Object.entries(opts)) {
    if (value !== undefined && flagJobs[name] !== known)
      throw new Error(`--${name} goes with \`a11y ${flagJobs[name]}\``);
  }
  if (known === 'report') return { job: known, publish: opts.publish === true, draft: opts.draft === true };
  if (known === 'decide') {
    const { file, ...decision } = opts;
    if (file !== undefined && Object.keys(decision).length > 0)
      throw new Error('--file holds the decisions: no other flags');
    return { job: known, decide: { file: text(file), decision: { ...decision, where: list(opts.where) } } };
  }
  const workers = opts.workers === undefined ? 4 : Number(opts.workers);
  if (!Number.isInteger(workers) || workers < 1) throw new Error('--workers takes a whole number, 1 or more');
  return { job: known, audit: { states: list(opts.states), workers, email: text(opts.email) } };
}

async function runA11y(forkPath: string, options: A11yOptions): Promise<number> {
  const resultsDir = toolDir(forkPath, 'a11y');
  if (options.job === 'decide') return runDecide(forkPath, options.decide);
  if (options.job === 'report') return runReport(forkPath, resultsDir, options);

  // Before the testbed starts: a scope that does not fit this CLI, or a missing browser, fails in seconds
  const scope = await loadScope(forkPath);
  const unknown = options.audit.states.filter((id) => !scope.states.some((state) => state.id === id));
  if (unknown.length > 0) {
    throw new Error(`no state ${unknown.join(', ')} in the scope: ${scope.states.map((state) => state.id).join(', ')}`);
  }
  await requireChromium(forkPath);
  const app = await loadAppConfig(forkPath, 'development');
  return withTestbed(forkPath, (testbed) => runAudit({ forkPath, app, resultsDir }, scope, testbed, options.audit));
}

export const a11yCommand: ToolCommand<A11yOptions> = {
  name: 'a11y',
  group: 'develop',
  description: 'audit the app against WCAG 2.2 AA on a testbed and keep the conformance ledger',
  jobs: [
    ['audit', 'axe, browser probes and code checks on every state; writes cella/a11y-ledger.json'],
    ['report', 'render the ledger as a draft VPAT and the checklist for the manual pass'],
    ['decide', "record a reviewer's decisions with their evidence"],
  ],
  options: [
    ['--states <ids>', 'audit: these states only, comma separated; writes ledger-partial.json, never the ledger'],
    ['--workers <n>', 'audit: states audited at the same time (default 4)'],
    ['--email <address>', 'audit: the audit user (default ADMIN_EMAIL in .env)'],
    ['--publish', 'report: put the PDF where the app serves it and print what the statement needs'],
    ['--draft', 'report: publish while rows still need a person; the statement calls the results provisional'],
    ['--file <path>', 'decide: a JSON list of decisions'],
    ['--id <criterion>', 'decide: the criterion, such as 2.4.6'],
    ['--status <status>', 'decide: supports, partially-supports, does-not-support, not-applicable or open'],
    ['--by <reviewer>', 'decide: agent or human'],
    ['--remarks <text>', 'decide: what the report tells its reader'],
    ['--evidence <text>', 'decide: what the reviewer looked at and found'],
    ['--where <ids>', 'decide: the states or files the finding is about, comma separated'],
  ],
  parse: parseA11y,
  run: runA11y,
};
