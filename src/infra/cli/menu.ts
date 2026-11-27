import { type MenuItem, rule } from '../../utils/menu';
import {
  actionCommand,
  type MenuRowId,
  menuPath,
  menuRow,
  menuRows,
  moreSections,
  type OperatorActionId,
  operatorActions,
} from '../lib/operator-actions';
import type { StackState } from '../lib/stack/bootstrap-stack-state';
import type { Environment } from '../lib/stack/environment';
import { pc } from '../lib/utils/cli-output';

/** The step the home screen recommends, when one action of the CLI does it: the menu leads with it. */
export interface UpNext {
  action: OperatorActionId;
  description: string;
}

/** What the menu knows about the stack and this machine, to say which entries can run. */
export interface MenuState {
  stackState: StackState;
  environment: Environment;
  /** The local exposure config says the public DB endpoint is open. */
  dbExposed: boolean;
  /** The instance's live public endpoints, when the observer key read them in time. */
  liveEndpoints?: string[];
  upNext?: UpNext;
}

export const backChoice = 'back';
/** The value of the row that leaves the CLI, or steps back to the package menu: the main menu's, and the frame's after a first setup. */
export const quitChoice = 'quit';
/** The label of the row that returns to the menu. */
export const backToMenuLabel = '← Back to menu';
/** The value of the row that runs the recommended step. */
export const upNext = 'up-next';

/** What the main menu resolves to: a row, the recommended step, or the way out. */
export type MainMenuValue = MenuRowId | typeof upNext | typeof quitChoice;

const needsBootstrappedStack: readonly OperatorActionId[] = [
  'apply',
  'preview',
  'db-reset',
  'db-seed',
  'db-open',
  'db-close',
  'deploy-now',
  'releases',
];

/**
 * Why an action cannot run now, undefined when it can. Each reason names the action that lifts it: for the menu by its menu path, short
 * enough for one 80-column row; for a run without the menu (`menu` false) as whole sentences that end on the command.
 */
export function disabledReason(id: OperatorActionId, state: MenuState, menu = true): string | undefined {
  if (id === 'db-seed' && state.environment === 'production') return `seed data never goes to production${menu ? '' : '.'}`;
  if (needsBootstrappedStack.includes(id) && state.stackState !== 'bootstrapped') {
    return menu
      ? `needs a set-up environment: run "${menuPath('resume')}"`
      : `it needs a set-up environment.\n  Run ${pc.cyan(`${actionCommand('resume')} --mode ${state.environment}`)}`;
  }
  return undefined;
}

/** Why a row cannot be entered: every action behind it is blocked. The reason is the first action's. */
export function rowDisabledReason(id: MenuRowId, state: MenuState): string | undefined {
  const reasons = menuRow(id).actions.map((action) => disabledReason(action, state));
  return reasons.every(Boolean) ? reasons[0] : undefined;
}

/** True when a public DB endpoint is open: by the local exposure config, or live on the instance. */
function dbIsOpen(state: MenuState): boolean {
  return state.dbExposed || (state.liveEndpoints?.length ?? 0) > 0;
}

/** The row ids the menu lists for a state: every row, with the one DB access row that applies. */
export function visibleRows(state: MenuState): MenuRowId[] {
  const hidden: MenuRowId = dbIsOpen(state) ? 'db-open' : 'db-close';
  return (Object.keys(menuRows) as MenuRowId[]).filter((id) => id !== hidden);
}

/** A row's label as the menu shows it: `›` marks a row that opens a pick, and the close row says the endpoint is open. */
function rowLabel(id: MenuRowId): string {
  const row = menuRow(id);
  if (id === 'db-close') return `${row.label} (OPEN)`;
  return row.actions.length > 1 ? `${row.label} ›` : row.label;
}

/** An entry's name: the label, with the open endpoint in yellow. */
function entryName(id: MenuRowId): string {
  return rowLabel(id).replace('(OPEN)', pc.yellow('(OPEN)'));
}

/**
 * The main menu: the recommended step and a blank line first when there is one, then every row with its description dim beside it, then
 * the way out: `Quit`, or `← Back` when the package menu opened the CLI. A disabled row shows its reason in place of the description.
 */
export function mainMenuItems(state: MenuState, back = false): Array<MenuItem<MainMenuValue>> {
  const items: Array<MenuItem<MainMenuValue>> = [];
  if (state.upNext) items.push({ name: `${pc.cyan('▶')}  ${state.upNext.description}`, value: upNext }, { group: '' });
  const rows = visibleRows(state);
  const width = Math.max(...rows.map((id) => rowLabel(id).length));
  for (const id of rows) {
    const reason = rowDisabledReason(id, state);
    const live = state.liveEndpoints ?? [];
    const stray = id === 'db-close' && !state.dbExposed && live.length > 0;
    items.push({
      name: reason ? rowLabel(id) : `${entryName(id)}${' '.repeat(width - rowLabel(id).length)}  ${pc.dim(menuRow(id).description)}`,
      value: id,
      ...(stray ? { description: `Public endpoint ${live.join(', ')} is open, though no exposure is configured: close it.` } : {}),
      ...(reason ? { disabled: `(${reason})` } : {}),
    });
  }
  items.push(rule, { name: back ? '← Back' : 'Quit', value: quitChoice });
  return items;
}

/** An action's entry in a pick: its command word padded to the summary column, then its summary dim. A disabled entry shows the word alone, so the reason after it fits the row. */
function pickName(action: OperatorActionId, width: number, disabled: boolean): string {
  return disabled ? action : `${action.padEnd(width)}  ${pc.dim(operatorActions[action].summary)}`;
}

/** The sections a row's pick lists its actions in: the More pick's, one for any other row. */
function pickSections(id: MenuRowId): Array<readonly OperatorActionId[]> {
  return id === 'more' ? Object.values(moreSections) : [menuRow(id).actions];
}

/** The pick a row with several actions opens: its actions with their summaries, a rule between sections, then the way back. */
export function pickItems(id: MenuRowId, state: MenuState): Array<MenuItem<OperatorActionId | typeof backChoice>> {
  const width = Math.max(...menuRow(id).actions.map((action) => action.length));
  const items: Array<MenuItem<OperatorActionId | typeof backChoice>> = [];
  for (const actions of pickSections(id)) {
    if (items.length) items.push(rule);
    for (const action of actions) {
      const reason = disabledReason(action, state);
      items.push({ name: pickName(action, width, Boolean(reason)), value: action, ...(reason ? { disabled: `(${reason})` } : {}) });
    }
  }
  return [...items, rule, { name: backToMenuLabel, value: backChoice }];
}
