import { existsSync } from 'node:fs';
import { commandTitle } from '../../utils/display';
import { escaped, menuSelect } from '../../utils/menu';
import { dbExposureConfigured } from '../lib/db-public-endpoint';
import { type MenuRowId, menuRow, type OperatorActionId, pulumiActions } from '../lib/operator-actions';
import { resolveOperatorIdentity } from '../lib/scaleway/operator-identity';
import { detectComputeDeferred, pickStackShort } from '../lib/stack/bootstrap-stack-state';
import { type Environment, environments, isEnvironment } from '../lib/stack/environment';
import { stackFilePath, writeStackFileProjectId } from '../lib/stack/project-per-mode';
import { loadStackContext } from '../lib/stack/stack-context';
import { crossMark, hasPerson, pc, printFailureHint, warningMark, withSpinner } from '../lib/utils/cli-output';
import { dropPromptOnlyEnv, loadRootEnvFile, refuseFilesLeftBehind, removeModeProjectId } from '../lib/utils/env-files';
import { installedPulumiVersion, pulumiCliLagWarning, sdkPulumiVersion } from '../lib/utils/pulumi-version';
import { type ActionOutcome, runAction } from './actions';
import { printLaunchChecklist } from './actions/setup-checklist';
import { type CliArgs, splitFlagValues } from './args';
import { checkoutVersion, formatHeader } from './header';
import { collectHome, formatHome, type HomeFacts, upNextOf } from './home';
import { backChoice, disabledReason, type MenuState, mainMenuItems, pickItems, quitChoice, upNext, visibleRows } from './menu';
import { installPromptAbortHandler } from './prompts/abort';
import { select } from './prompts/back';
import { leaveChoice } from './prompts/what-now';
import { forgetSession, rememberEnvironment, startMenuSession } from './session';
import type { InfraContext } from './shared';
import { autoAcceptDefaults, pointTo } from './shared';

/**
 * The target mode. `--mode` or INFRA_MODE selects it explicitly, including a fresh stack with no Pulumi.<mode>.yaml yet;
 * otherwise the only existing stack file wins silently, two existing stack files ask once (under `--defaults` they need `--mode`), and with no stack
 * file an interactive install asks, defaulting to production.
 * A mode-scoped `cella/infra/.env.<mode>` OVERRIDES the ambient env: a staging run cannot inherit production keys from the repo-root .env.
 */
async function resolveMode(flag: string | undefined): Promise<Environment> {
  const raw = flag ?? process.env.INFRA_MODE;
  if (raw) {
    if (!isEnvironment(raw)) throw new Error(`INFRA_MODE must be 'production' or 'staging' (got '${raw}')`);
    return raw;
  }
  const anyStackExists = environments.some((name) => existsSync(stackFilePath(name)));
  if (!anyStackExists && !autoAcceptDefaults()) {
    return select<Environment>({
      message: 'New app. Which environment do you want to set up?',
      default: 'production',
      choices: [
        {
          name: 'production',
          value: 'production',
          description: 'Deploys every release you publish.',
        },
        {
          name: 'staging (optional)',
          value: 'staging',
          description: "A second environment, billed apart. It deploys only while cella/infra/environments has the line 'staging branch:main'.",
        },
      ],
    });
  }
  const existing = environments.filter((name) => existsSync(stackFilePath(name)));
  if (existing.length === 2) {
    if (autoAcceptDefaults()) {
      throw new Error('Both Pulumi.production.yaml and Pulumi.staging.yaml exist: pass --mode (or set INFRA_MODE).');
    }
    return select<Environment>({ message: 'Which environment?', choices: existing.map((name) => ({ name, value: name })) });
  }
  return pickStackShort((name) => existsSync(stackFilePath(name)));
}

/**
 * Load the stack context for a mode. The menu loads it again after every action that can change the stack or this machine's keys, so the
 * next round reads the env file, the stack config and the stack state as the action left them; `log` receives the env-file notices.
 */
async function loadContext(environment: Environment, log?: (message: string) => void): Promise<InfraContext> {
  rememberEnvironment(environment);
  const stack = await loadStackContext(environment, log);
  // The project id scopes every Scaleway call. Only a fresh install may lack one: the setup wizard picks or creates the project and writes it to the stack file.
  if (!stack.projectId && stack.state !== 'fresh') {
    throw new Error(
      `cella/infra/Pulumi.${environment}.yaml names no project: add this environment's project id under config, as infra:projectId, before running the infra CLI.`,
    );
  }
  // An existing stack whose project an env file still names moves it to the stack file, which every checkout has.
  if (stack.projectIdSource === 'env-file' && stack.stackYaml) {
    writeStackFileProjectId(environment, stack.projectId);
    log?.(`The project id moved to cella/infra/Pulumi.${environment}.yaml: commit that file.`);
  }
  // A stack file that came with a pull names the project already: the env file's copy goes.
  if (stack.projectIdSource === 'stack-file') removeModeProjectId(environment);
  return { ...stack, hasCiKey: stack.state === 'bootstrapped' };
}

/** What the menu needs to say which entries can run, from the home screen's reads. */
function menuState(context: InfraContext, home?: HomeFacts): MenuState {
  return {
    stackState: context.state,
    environment: context.environment,
    dbExposed: dbExposureConfigured(context.environment, context.stackYaml),
    liveEndpoints: home?.liveEndpoints,
    upNext: home ? upNextOf(home.report, home.refs) : undefined,
  };
}

/** The header, then the notices that hold for the whole run: key misconfigurations and deferred compute. `menu` when the menu follows. */
function printStackNotices(context: InfraContext, menu = true): void {
  const host = context.appConfig.frontendUrl ? new URL(context.appConfig.frontendUrl).host : undefined;
  console.info(formatHeader({ version: checkoutVersion(), environment: context.environment, state: context.state, host }));

  // One line per key misconfiguration (a superseded name in the env file, a key the CLI no longer reads, …) before any action trips over it.
  for (const warning of [...context.envWarnings, ...resolveOperatorIdentity().warnings]) console.warn(`${warningMark} ${warning}`);

  if (detectComputeDeferred(context.stackYaml)) {
    console.warn(`${warningMark} ${pc.bold('The first setup has not finished')}: ${pointTo('resume', menu)} continues it.\n`);
  }
}

/**
 * The home screen: one round of reads under a spinner, then the lines. `read` is either the reads an action started at its end, waited for
 * under the spinner, or the lines of the last round after an action that changed nothing. Resolves to what it read, for the menu. A stack
 * not set up yet gets the launch checklist.
 */
async function printHome(context: InfraContext, read?: HomeFacts | Promise<HomeFacts | undefined>): Promise<HomeFacts | undefined> {
  if (context.state !== 'bootstrapped') {
    await printLaunchChecklist(context);
    return undefined;
  }
  const home =
    read && !(read instanceof Promise)
      ? read
      : await withSpinner(`Checking ${context.environment}`, async () => (await read) ?? collectHome(context));
  for (const line of formatHome(home)) console.info(line);
  console.info('');
  return home;
}

let pulumiLagShown = false;

/**
 * True when an action may run as far as Pulumi is concerned: one that runs no Pulumi always, one that does once the CLI is installed. A
 * laptop whose CLI trails the SDK is told once: the main job runs the SDK's version, and a newer engine may write a state an older CLI
 * refuses.
 */
function pulumiReady(action: OperatorActionId): boolean {
  if (!pulumiActions.includes(action)) return true;
  const installed = installedPulumiVersion();
  if (!installed) {
    printFailureHint(`"${action}" runs Pulumi, which this machine does not have`, {
      command: 'brew install pulumi/tap/pulumi',
      description: 'reading (status, logs) works without it',
    });
    return false;
  }
  const lag = pulumiCliLagWarning(installed, sdkPulumiVersion());
  if (lag && !pulumiLagShown) {
    pulumiLagShown = true;
    console.warn(`${warningMark} ${lag}`);
  }
  return true;
}

/** The row the cursor starts on: the one last entered, so a second action in the same area is one keypress away. */
let lastRow: MenuRowId | typeof upNext = 'status';

/** The row the cursor starts on in this state: the recommended step, else the last row, its DB access counterpart once the endpoint changed side, else the first. */
function startRow(state: MenuState): MenuRowId | typeof upNext {
  if (state.upNext) return upNext;
  const rows = visibleRows(state);
  if (lastRow === upNext) return 'status';
  if (rows.includes(lastRow)) return lastRow;
  return lastRow === 'db-open' ? 'db-close' : lastRow === 'db-close' ? 'db-open' : 'status';
}

/**
 * The menu: the daily rows by use, then More with the rest. A row with one action runs it; a row with several opens a pick, where Esc or
 * Back returns to the list. Esc on the list leaves the CLI, or with `back` steps back to the package menu. A row that cannot run now stays
 * listed with the reason. A pick opens on its first entry: a stray Enter after an action never starts one that deletes data.
 */
async function chooseAction(state: MenuState, back: boolean): Promise<OperatorActionId | typeof quitChoice> {
  while (true) {
    const picked = await menuSelect({ message: '', items: mainMenuItems(state, back), default: startRow(state) });
    if (picked === escaped || picked === quitChoice) return quitChoice;
    lastRow = picked;
    if (picked === upNext) {
      const next = state.upNext;
      if (!next) continue;
      const reason = disabledReason(next.action, state);
      if (!reason) return next.action;
      console.error(`${crossMark} "${next.action}" cannot run now: ${reason}.`);
      continue;
    }
    const row = menuRow(picked);
    const [only] = row.actions;
    if (row.actions.length === 1 && only) return only;
    const action = await menuSelect({ message: commandTitle('infra'), items: pickItems(picked, state) });
    if (action !== escaped && action !== backChoice) return action;
  }
}

/** Actions that change nothing, so the menu comes back without reading the stack again. */
const readOnly: readonly OperatorActionId[] = ['status', 'logs', 'preview'];

/** How long reads started at an action's end serve the menu: an operator who comes back later sees the stack as it is then. */
const aheadFreshMs = 30_000;

/** The next round's reads, started while an action's output waits for the way back: the stack, then the home once the stack is set up. */
function readAhead(environment: Environment): { startedAt: number; context: Promise<InfraContext>; home: Promise<HomeFacts | undefined> } {
  const read = loadContext(environment);
  const home = read.then((next) => (next.state === 'bootstrapped' ? collectHome(next) : undefined));
  // A failed read throws where the menu awaits it, not at the prompt the operator is on.
  home.catch(() => {});
  return { startedAt: Date.now(), context: read, home };
}

/**
 * The infra CLI on a command line `runInfra` accepted: the menu, or one action with `pnpm cella infra <action>`. It ends the process
 * itself, with the action's code or the menu's way out. Opened by the package menu (`back`), the menu's `← Back` returns from it.
 */
export async function runInfraCli(args: CliArgs): Promise<void> {
  // The actions read their flags on process.argv, where `--sha=<sha>` must read as `--sha <sha>` too.
  process.argv = splitFlagValues(process.argv);

  // A stack file left in infra/ would read as an environment not set up yet. The warnings for old copies print with the stack's notices.
  refuseFilesLeftBehind();

  // Load the repo-root .env so infra child tasks share the app's local config; ambient env keeps precedence over the file.
  loadRootEnvFile();

  // A privileged key in the environment would let the CLI run with nobody at the prompt: it is dropped here and asked for.
  const droppedFromEnv = dropPromptOnlyEnv();

  // A Ctrl-C at any prompt below ends the run with one line and releases a held lease.
  const removeAbortHandler = installPromptAbortHandler();

  console.info('');
  const environment = await resolveMode(args.mode);
  let context = await loadContext(environment, (message) => console.info(pc.dim(message)));

  // Refuse an app host the load balancer cannot serve before any prompt or provisioning step.
  {
    const { frontendApexIssue, routedHostIssue } = await import('../lib/naming');
    const issue = frontendApexIssue(context.appConfig) ?? routedHostIssue(context.appConfig);
    if (issue) {
      console.error(`${crossMark} ${issue}`);
      process.exit(1);
    }
  }

  printStackNotices(context, !args.action);
  if (droppedFromEnv.length > 0) {
    console.warn(
      `${warningMark} ${droppedFromEnv.join(', ')} ${droppedFromEnv.length === 1 ? 'is' : 'are'} set in this shell or in .env and not read: the CLI asks for a privileged key at the prompt.\n`,
    );
  }

  // `pnpm cella infra <action>`: one action, no menu. An action the stack cannot run now says why, as its menu entry does.
  if (args.action) {
    const reason = disabledReason(args.action, menuState(context), false);
    if (reason) {
      console.error(`${crossMark} ${args.action} cannot run now: ${reason}`);
      process.exit(1);
    }
    if (!pulumiReady(args.action)) process.exit(1);
    process.exit((await runAction(args.action, context)).code);
  }

  // A fresh install has nothing to manage yet and automation has nobody to ask: both go straight to the setup. A person at a terminal
  // stays in the CLI: a failure offers the step again, and a setup that succeeds opens the menu.
  if (context.state === 'fresh') {
    if (!pulumiReady('resume')) process.exit(1);
    const { code, quit } = await runAction('resume', context, { firstSetup: true, ...(args.once ? { close: async () => leaveChoice } : {}) });
    if (code !== 0 || quit || args.once || !hasPerson()) process.exit(code);
    context = await loadContext(environment);
    if (context.state === 'fresh') process.exit(0);
    printStackNotices(context);
  }

  // From here an action that fails or is stopped returns to the menu, unless the run leaves after one.
  if (!args.once) startMenuSession();
  let home = await printHome(context);
  /** The action the operator chose from a failure's ways out, run before the menu shows again. */
  let next: OperatorActionId | undefined;
  while (true) {
    const action = next ?? (await chooseAction(menuState(context, home), args.back === true));
    const reason = next ? disabledReason(next, menuState(context, home)) : undefined;
    next = undefined;
    if (action === quitChoice) break;
    if (reason) {
      console.error(`${crossMark} "${action}" cannot run now: ${reason}.`);
      continue;
    }
    let ahead: ReturnType<typeof readAhead> | undefined;
    const onEnded = () => {
      if (!readOnly.includes(action)) ahead = readAhead(environment);
    };
    const outcome: ActionOutcome = pulumiReady(action) ? await runAction(action, context, { onEnded }) : { code: 1 };
    if (args.once) process.exit(outcome.code);
    next = outcome.next;
    console.info('');
    if (ahead && Date.now() - ahead.startedAt > aheadFreshMs) ahead = undefined;
    // An action may have changed the stack file, the env file or the live stack: all three are read again for the next round.
    const changed = !readOnly.includes(action) && !outcome.back;
    if (changed) context = await (ahead?.context ?? loadContext(environment));
    if (next) continue;
    // The menu comes back under its header and home: a short terminal shows the action is over.
    printStackNotices(context);
    home = await printHome(context, ahead?.home ?? (changed ? undefined : home));
  }
  if (!args.back) process.exit(0);
  // The package menu takes the run back: nothing typed in this session outlives it
  const held = forgetSession();
  removeAbortHandler();
  if (held.length > 0) console.info(pc.dim(`Left infra: the ${held.join(' and ')} key${held.length > 1 ? 's are' : ' is'} forgotten.`));
}
