import type { Page } from 'playwright';
import { type AxeScan, axeScan } from './axe-scan';
import type { A11yState } from './define';
import type { AuditRun, Check, Finding } from './findings';
import { controlContrast, textContrast } from './probes/contrast';
import { formErrors, inputs } from './probes/forms';
import { keyboardWalk } from './probes/keyboard';
import { layout } from './probes/layout';
import { languageSwitch, pageStructure } from './probes/page-structure';
import { packetDir, removePacketFile, reviewPacket, writePacketFile } from './review-packet';
import { type AuditSession, auditContext, type Mode, openStatePath } from './session';

interface Visit {
  findings: Finding[];
  scan: AxeScan;
}

/**
 * Opens one state once and runs every check on that page.
 *
 * The light visit runs them in an order that keeps each check's page intact: checks that only read come first, then the
 * ones that restore what they change, and last the keyboard walk, whose Escape closes the state's overlay, and the
 * language switch, which changes the stored language.
 *
 * The dark visit runs what depends on the color mode: axe's contrast rule and the two contrast probes.
 *
 * A step that throws fails the visit, so a state with findings missing never reaches the ledger. The visit then leaves
 * `failure-<mode>.png` and `failure-<mode>.json` in the state's review packet: what the page showed, its console
 * errors, and the steps that ran on it before, since a failing step often meets what an earlier one left behind.
 */
export async function visitState(run: AuditRun, session: AuditSession, state: A11yState, mode: Mode): Promise<Visit> {
  const context = await auditContext(session, { auth: state.auth, mode }, state.context);
  const consoleErrors: string[] = [];
  context.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  context.on('weberror', (webError) => consoleErrors.push(webError.error().message));

  const record = `failure-${mode}`;
  for (const extension of ['png', 'json']) removePacketFile(run, state.id, `${record}.${extension}`);

  /** Steps that finished on this page, in order. */
  const done: string[] = [];
  let step = 'open';
  let page: Page | undefined;
  try {
    page = await openStatePath(session, context, state);
    await state.open?.(page);
    done.push(step);
    const opened = page;
    const where = `${state.id} (${mode})`;

    const findings: Finding[] = [];
    // `name` for a check built by a call, which has no name of its own
    const runCheck = async (check: Check, name = check.name) => {
      step = name;
      for (const finding of await check(opened, state, run)) {
        findings.push({ ...finding, state: mode === 'dark' ? where : state.id });
      }
      done.push(step);
    };
    const scanPage = async (contrastOnly?: boolean) => {
      step = 'axe';
      const scan = await axeScan(opened, where, contrastOnly);
      done.push(step);
      return scan;
    };

    if (mode === 'dark') {
      const scan = await scanPage(true);
      await runCheck(textContrast(scan.undecidedContrast), 'textContrast');
      await runCheck(controlContrast);
      return { findings, scan };
    }

    for (const check of [pageStructure, inputs]) await runCheck(check);
    const scan = await scanPage();
    await runCheck(textContrast(scan.undecidedContrast), 'textContrast');
    for (const check of [controlContrast, reviewPacket, layout, formErrors, keyboardWalk, languageSwitch])
      await runCheck(check);
    return { findings, scan };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The page may be gone, as after a crash; the record is worth having without its picture
    const screenshot = await page
      ?.screenshot({ fullPage: true, animations: 'disabled', timeout: 5000 })
      .catch(() => null);
    if (screenshot) writePacketFile(run, state.id, `${record}.png`, screenshot);
    const failure = { step, error: message, after: done, url: page?.url() ?? null, consoleErrors };
    writePacketFile(run, state.id, `${record}.json`, `${JSON.stringify(failure, null, 2)}\n`);

    const previous = done.at(-1);
    const hint = `${previous ? `after ${previous}; ` : ''}see ${packetDir(run, state.id)}/${record}.json`;
    throw new Error(`${step}: ${message.split('\n')[0]} (${hint})`);
  } finally {
    await context.close();
  }
}
