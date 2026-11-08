import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from '../../utils/colors';
import { printStep, warningMark } from '../../utils/display';
import { onShutdown } from '../../utils/signals';
import type { TestbedHandle } from '../testbed';
import { type AxeScan, summarizeAxe } from './axe-scan';
import { runCodeChecks } from './code-checks';
import { type AuditRun, EvidenceSet, type Finding } from './findings';
import { ledgerFile, writeLedger } from './ledger';
import { acrossStates } from './probes/page-structure';
import type { Scope } from './scope';
import { endAudit, startAudit } from './session';
import { visitState } from './visit';

export interface AuditOptions {
  /** State ids to audit; all when empty. */
  states: string[];
  workers: number;
  /** The audit user; default the testbed's `ADMIN_EMAIL`. */
  email?: string;
}

const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;

/**
 * Audits the testbed against WCAG 2.2 A and AA and writes the conformance ledger, or `ledger-partial.json` in the
 * results folder when the run covered part of the scope or skipped a visit: an incomplete run never replaces the
 * ledger. Resolves to the exit code: 1 when a visit was skipped.
 */
export async function runAudit(run: AuditRun, scope: Scope, testbed: TestbedHandle, options: AuditOptions) {
  const startedAt = Date.now();
  const email = options.email ?? testbed.env.ADMIN_EMAIL;
  if (!email) throw new Error('no audit user: pass --email, or set ADMIN_EMAIL in .env');

  // A build is as old as its last `vite build`: say so, since a stale one audits old code without a sign
  const builtAt = statSync(join(run.forkPath, 'frontend/dist/index.html'), { throwIfNoEntry: false })?.mtime;
  printStep('auditing', `${testbed.frontendUrl}, frontend build of ${builtAt?.toLocaleString() ?? 'unknown date'}`);

  const states =
    options.states.length > 0 ? scope.states.filter((state) => options.states.includes(state.id)) : scope.states;
  const session = await startAudit(run.forkPath, scope, { email, env: testbed.env });
  const forget = onShutdown(() => endAudit(session));

  const findings: Finding[] = [];
  const scans: AxeScan[] = [];
  const errors: Record<string, string> = {};

  /** One visit: a state in a color mode. Dark visits measure contrast only. */
  const visits = (['light', 'dark'] as const).flatMap((mode) => states.map((state) => ({ state, mode })));

  /** Takes visits from the shared queue until it is empty. */
  const worker = async () => {
    for (let visit = visits.shift(); visit; visit = visits.shift()) {
      const { state, mode } = visit;
      const visitStartedAt = Date.now();
      const label = `${state.id} (${mode})`;
      try {
        const result = await visitState(run, session, state, mode);
        findings.push(...result.findings);
        scans.push(result.scan);
        console.info(`  ${label} ${pc.dim(seconds(visitStartedAt))}`);
      } catch (error) {
        errors[label] = error instanceof Error ? error.message.split('\n')[0] : String(error);
        console.info(`  ${warningMark} ${label} skipped: ${errors[label]}`);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: options.workers }, worker));
  } finally {
    await endAudit(session);
    forget();
  }

  // Visits finish in any order; scope order keeps the ledger stable between runs
  const position = (label: string) =>
    scope.states.findIndex((state) => label === state.id || label.startsWith(`${state.id} (`));
  findings.sort((a, b) => position(a.state) - position(b.state));
  scans.sort(
    (a, b) =>
      Number(a.where.endsWith('(dark)')) - Number(b.where.endsWith('(dark)')) || position(a.where) - position(b.where),
  );

  const evidence = new EvidenceSet();
  mkdirSync(run.resultsDir, { recursive: true });
  const axe = summarizeAxe(scans);
  for (const [id, items] of axe.evidence) for (const item of items) evidence.add([id], item);
  writeFileSync(join(run.resultsDir, 'axe.json'), `${JSON.stringify({ ...axe.report, errors }, null, 2)}\n`);
  evidence.addFindings(acrossStates(findings));
  runCodeChecks(evidence, run, scope.sources);

  // The ledger describes the whole scope, so a run that covered only part of it writes a separate file
  const skipped = Object.keys(errors).length;
  const target =
    options.states.length > 0 || skipped ? join(run.resultsDir, 'ledger-partial.json') : join(run.forkPath, ledgerFile);
  const ledger = writeLedger(
    run.forkPath,
    evidence.byCriterion,
    states.map((state) => state.id),
    target,
  );

  const count = (status: string | null) => ledger.criteria.filter((row) => row.status === status).length;
  console.info();
  console.info(
    `  ${ledger.criteria.length} criteria: ${count('supports')} supports, ${count('partially-supports')} partially ` +
      `supports, ${count('not-applicable')} not applicable, ${count(null)} open`,
  );
  for (const row of ledger.criteria.filter((r) => r.status === 'partially-supports')) {
    const failures = row.evidence.filter((e) => e.result === 'fail').map((e) => e.summary);
    console.info(`    ${row.id} ${row.name}: ${pc.dim(failures.join(' '))}`);
  }
  console.info();
  printStep('ledger', target);
  printStep('results', run.resultsDir);
  printStep('done', `in ${seconds(startedAt)}${skipped ? `, ${skipped} visits skipped` : ''}`);
  return skipped ? 1 : 0;
}
