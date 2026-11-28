export interface OperatorAction {
  /** Shown dim beside the action's row or pick entry: a lowercase phrase that fits one 80-column line with the id. */
  summary: string;
  /** What the action does, shown under a failure's way to it while that is highlighted: one line of at most 96 characters that names no key. */
  description: string;
}

/**
 * Every operator action of the infra CLI, keyed by the id that also runs it: `pnpm cella infra <id>`. The id is the action's one name: its
 * menu entry, every message that mentions it and the docs. A message that sends the operator to an action names it through
 * {@link menuPath} or {@link actionCommand}.
 */
export const operatorActions = {
  status: {
    summary: 'every check and finding, and what fixes it',
    description: 'Every check and finding, what it means and what fixes it. Read-only.',
  },
  logs: {
    summary: 'the last deploys and how each ended',
    description: 'The last deploys and how each ended, then one in full with the end of its log. Read-only.',
  },
  preview: {
    summary: 'what apply would change; read-only',
    description: 'The changes apply would make, read fresh against what runs. Read-only.',
  },
  apply: {
    summary: 'what differs from what runs, applied on your yes',
    description: 'See what differs between the code and what runs, and apply it on your yes.',
  },
  'rotate-keys': {
    summary: 'new deploy and uploads keys, then a redeploy',
    description: 'Replace the deploy and uploads keys, then redeploy so no machine keeps an old one.',
  },
  'rotate-secrets': {
    summary: 'new passwords and generated values, redeployed',
    description: 'New database passwords and generated values, then deploys what serves again.',
  },
  operators: {
    summary: 'make or repair the operator app and group',
    description: "Make or repair the app's operator application and operators group.",
  },
  identities: {
    summary: 'write what differs from the declared identities',
    description: 'Write what differs from the declared identities. Asks for a key only when something must change.',
  },
  'deploy-now': {
    summary: 'without waiting for the scheduled run',
    description: 'Deploy the target now, without waiting for the scheduled run, and follow it step by step.',
  },
  releases: {
    summary: 'the last releases; deploy an earlier one again',
    description: 'The last releases and how each deploy ended; pick an earlier one to deploy it again.',
  },
  'repository-key': {
    summary: 'the GitHub key a private repository needs',
    description: 'Store, replace or remove the read-only GitHub key a private repository needs.',
  },
  env: {
    summary: 'the values the services read at boot',
    description: 'The values the services read at boot. A changed value reaches the machines at the next deploy.',
  },
  'env-import': {
    summary: 'set the values a .env file holds',
    description: 'Set the values a .env file holds, such as one from another host, after one confirmation.',
  },
  'db-open': {
    summary: 'a public endpoint to your IP, until you close it',
    description: 'Open a public endpoint to your IP and print the admin connection string. Close it when done.',
  },
  'db-seed': {
    summary: 'the backend seeds, over a short-lived endpoint',
    description: 'Open the endpoint to your IP, run the backend seeds, and close it again. Never on production.',
  },
  'db-close': {
    summary: 'close the temporary public endpoint',
    description: 'Close the temporary public endpoint.',
  },
  'db-reset': {
    summary: 'wipe and rebuild it empty, after a backup',
    description: 'Wipe the database and rebuild it empty, after a backup.',
  },
  unlock: {
    summary: 'clear the lease a stopped run left',
    description: 'Clear the lease a stopped run left, and review what it left unfinished in the Pulumi state.',
  },
  resume: {
    summary: 'continue an interrupted install',
    description: 'Continue an interrupted install: re-sync config and self-heal missing keys.',
  },
  'state-remove': {
    summary: 'drop a gone resource from the Pulumi state',
    description: 'Take out of the Pulumi state a resource the code no longer declares and that is gone already.',
  },
  teardown: {
    summary: 'delete all that runs or costs, after a final dump',
    description: 'Delete everything that runs or costs, after a final dump that is kept.',
  },
} as const satisfies Record<string, OperatorAction>;

export type OperatorActionId = keyof typeof operatorActions;

export interface MenuRow {
  /** The row's name: the action's id for a row with one action. */
  label: string;
  /** The actions behind the row; more than one opens a short pick. */
  actions: readonly OperatorActionId[];
  /** Shown dim beside the row: a lowercase phrase that fits one 80-column line with the label. */
  description: string;
}

/** The actions a person runs rarely, in the sections of the More pick, in pick order. A rule divides the sections; their names head them in the help. */
export const moreSections = {
  Deploy: ['deploy-now', 'preview'],
  'Keys and identities': ['rotate-keys', 'rotate-secrets', 'operators', 'identities', 'repository-key'],
  Repairs: ['unlock', 'resume', 'state-remove'],
  Database: ['db-seed', 'db-reset'],
  Environment: ['env-import', 'teardown'],
} as const satisfies Record<string, readonly OperatorActionId[]>;

/** A row of the menu for one action, under its id and summary. */
function actionRow(id: OperatorActionId): MenuRow {
  return { label: id, actions: [id], description: operatorActions[id].summary };
}

/**
 * The rows of the `pnpm cella infra` menu, in menu order: the daily ones by how often a person comes for them, then More with the rest.
 * `db-open` and `db-close` share one place: the menu lists the one that applies. No action is reached by its command alone: each has a row.
 */
export const menuRows = {
  status: actionRow('status'),
  apply: actionRow('apply'),
  env: actionRow('env'),
  releases: actionRow('releases'),
  logs: actionRow('logs'),
  'db-open': actionRow('db-open'),
  'db-close': actionRow('db-close'),
  more: {
    label: 'more',
    actions: Object.values(moreSections).flat(),
    description: 'deploy now, keys, repairs, the database, teardown',
  },
} as const satisfies Record<string, MenuRow>;

export type MenuRowId = keyof typeof menuRows;

/** The actions that run the Pulumi CLI: the ones that need it installed, at the SDK's version. */
export const pulumiActions: readonly OperatorActionId[] = [
  'apply',
  'preview',
  'resume',
  'rotate-secrets',
  'db-open',
  'db-seed',
  'db-close',
  'db-reset',
  'unlock',
  'state-remove',
  'teardown',
];

/** One menu row under the shared shape. */
export function menuRow(id: MenuRowId): MenuRow {
  return menuRows[id];
}

/** True when `value` is the id of an operator action, for a command line that names one. */
export function isOperatorActionId(value: string): value is OperatorActionId {
  return Object.hasOwn(operatorActions, value);
}

/** The command that runs an action without the menu. */
export function actionCommand(id: OperatorActionId): string {
  return `pnpm cella infra ${id}`;
}

/**
 * Where an operator finds an action: `<row> › <id>` for an action picked inside a row, the id alone for a row of its own, and the command
 * for an action no row lists.
 */
export function menuPath(id: OperatorActionId): string {
  const row = (Object.values(menuRows) as MenuRow[]).find((entry) => entry.actions.includes(id));
  if (!row) return actionCommand(id);
  return row.actions.length === 1 ? id : `${row.label} › ${id}`;
}
