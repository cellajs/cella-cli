import { escaped, menuSelect } from '../../../utils/menu';
import { hasPerson, pc } from '../../lib/utils/cli-output';
import { backToMenuLabel, quitChoice } from '../menu';
import { inMenuSession, rememberedOperatorKey } from '../session';
import { isPromptAbort } from './abort';

/** One way out of a failure: what it does, and the line under the list while it is highlighted. */
export interface WayOut<T extends string> {
  value: T;
  label: string;
  /** Dim on the right: where the row leads. */
  hint?: string;
  description: string;
}

/** The value of the row that leaves a failure. */
export const leaveChoice = 'leave';

/** The row that leaves a failure: back to the menu in a menu session, out of the CLI otherwise. */
export function leaveRow(): WayOut<typeof leaveChoice> {
  return inMenuSession()
    ? { value: leaveChoice, label: backToMenuLabel, description: 'The menu lists every action again.' }
    : { value: leaveChoice, label: 'Quit', description: 'End this run.' };
}

/** The dim line under a failure's ways out when the run holds an operator key, or undefined. */
export function keptKeyNote(): string | undefined {
  return rememberedOperatorKey() ? 'Your operator key is kept for this run.' : undefined;
}

/**
 * Ask what to do after a failure: `? What now?` over its rows, with `note` dim under the highlighted row's line. Esc and Ctrl-C pick the
 * row that leaves, else the last one; without a terminal nobody can answer, so it is picked at once.
 */
export async function whatNow<T extends string>(rows: ReadonlyArray<WayOut<T>>, note?: string): Promise<T> {
  const leave = rows.find((row) => row.value === leaveChoice) ?? rows.at(-1);
  if (!leave) throw new Error('a failure needs a way out');
  if (!hasPerson()) return leave.value;
  const width = Math.max(...rows.map((row) => row.label.length));
  const picked = await menuSelect<T>({
    message: 'What now?',
    items: rows.map((row) => ({
      value: row.value,
      name: row.hint ? `${row.label.padEnd(width)}  ${pc.dim(row.hint)}` : row.label,
      description: note ? `${row.description}\n${pc.dim(note)}` : row.description,
    })),
  }).catch((error: unknown): typeof escaped => {
    if (isPromptAbort(error)) return escaped;
    throw error;
  });
  return picked === escaped ? leave.value : picked;
}

/** The frame under a finished first install, which has shown no menu yet: Open the menu first, on Enter, Esc and Ctrl-C alike, then Quit. */
export async function afterFirstInstall(): Promise<typeof leaveChoice | typeof quitChoice> {
  return whatNow<typeof leaveChoice | typeof quitChoice>([
    { value: leaveChoice, label: 'Open the menu', description: 'Every action of the CLI, under the home screen.' },
    { value: quitChoice, label: 'Quit', description: 'Leave the CLI.' },
  ]);
}

/**
 * The one row under an action that ended by itself: its output stays on screen until the operator goes on. Enter, Esc and Ctrl-C all return
 * to the menu, with a blank line between the row and the output.
 */
export async function backToMenu(): Promise<typeof leaveChoice> {
  if (!hasPerson()) return leaveChoice;
  await menuSelect({ message: '', items: [{ group: '' }, { name: backToMenuLabel, value: leaveChoice }] }).catch((error: unknown) => {
    if (!isPromptAbort(error)) throw error;
  });
  return leaveChoice;
}
