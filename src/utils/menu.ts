import process from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { Separator } from '@inquirer/core';
import select from '@inquirer/select';
import pc from './colors';
import { fitText, terminalColumns } from './layout';

/** A selectable menu entry. An entry that cannot run now stays in the list with `disabled` saying why. */
export interface MenuChoice<T extends string> {
  name: string;
  value: T;
  description?: string;
  disabled?: string;
}

/** A menu entry, the heading of a group of entries (an empty one is a blank line), or a rule. */
export type MenuItem<T extends string> = MenuChoice<T> | { group: string } | Separator;

/** The rule between the groups of a menu and above its way out. */
export const rule = new Separator(pc.dim('─'.repeat(40)));

/** What {@link menuSelect} resolves to when the operator leaves the menu with Esc without choosing. */
export const escaped: unique symbol = Symbol('menu-escaped');

export interface MenuSelectOptions<T extends string> {
  /** The line above the entries: a question ends in `?` and shows bold with Inquirer's mark, a title shows as given, and an empty one shows no line. */
  message: string;
  /** Lines drawn as they are above the message, which erase with the menu: the package's header. */
  header?: string;
  items: ReadonlyArray<MenuItem<T>>;
  /** The entry the cursor starts on. */
  default?: T;
}

/**
 * The page fills the terminal less the header, the question and the tallest description under it. A prompt taller than the terminal leaves
 * a copy of its top on every redraw.
 */
function pageSize({ message, header, items }: MenuSelectOptions<string>): number {
  const { rows = 24, columns = 80 } = process.stdout;
  const lines = (text: string) => Math.max(1, Math.ceil(stripVTControlCharacters(text).length / columns));
  const description = Math.max(0, ...items.map((item) => ('description' in item && item.description ? lines(item.description) : 0)));
  return Math.max(3, rows - (header?.split('\n').length ?? 0) - lines(message) - description - 1);
}

/**
 * One menu of the CLI: a select with group headings, no wrap-around, as many entries as the terminal holds and no help line. Esc leaves it and resolves to
 * {@link escaped}. The menu clears itself when it is left: the screen never stacks old menus. Inquirer's select has no Esc of its own, and
 * a keypress listener aborts it through an AbortController.
 */
export async function menuSelect<T extends string>(options: MenuSelectOptions<T>): Promise<T | typeof escaped> {
  const controller = new AbortController();
  // Node 26 reports a lone Esc with `meta` set: the name alone matches it.
  const onKeypress = (_chunk: unknown, key?: { name?: string; ctrl?: boolean }) => {
    if (key?.name === 'escape' && !key.ctrl) controller.abort();
  };
  emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', onKeypress);
  const question = options.message.endsWith('?');
  try {
    return await select<T>(
      {
        message: options.message,
        default: options.default,
        loop: false,
        pageSize: pageSize(options),
        choices: options.items.map((item) => ('group' in item ? new Separator(item.group ? pc.dim(` ${item.group}`) : ' ') : item)),
        // Inquirer bolds an empty message into a line of escape codes alone, which prints as a blank line.
        theme: {
          ...(question ? {} : { prefix: '' }),
          style: { keysHelpTip: () => '', message: (text: string) => [options.header, question ? pc.bold(text) : text].filter(Boolean).join('\n') },
        },
      },
      { signal: controller.signal, clearPromptOnDone: true },
    );
  } catch (error) {
    // An aborted prompt is the operator stepping out, not a failure.
    if (error instanceof Error && error.name === 'AbortPromptError') return escaped;
    throw error;
  } finally {
    process.stdin.removeListener('keypress', onKeypress);
  }
}

/** One row of a package list: the label, then the description dim beside it. */
export interface MenuEntry {
  value: string;
  label: string;
  description: string;
}

/**
 * A list of the package on {@link menuSelect}: the groups of entries in two columns with a rule between them, then the way out, `Quit`
 * or with `back` `← Back`. A description longer than its row is cut: a row the terminal wraps breaks the page count. Esc and the way out
 * resolve to undefined; ctrl-c says `Cancelled.` and ends the process. `start` is the entry the pointer opens on.
 */
export async function pickFromMenu(
  groups: MenuEntry[][],
  { title = '', header, back = false, start }: { title?: string; header?: string; back?: boolean; start?: string } = {},
): Promise<string | undefined> {
  const width = Math.max(...groups.flat().map((entry) => entry.label.length)) + 3;
  const room = terminalColumns() - width - 3;
  const items = groups.flatMap((group, i) => [
    ...(i > 0 ? [rule] : []),
    ...group.map(({ value, label, description }) => ({ value, name: `${label.padEnd(width)}${pc.dim(fitText(description, room))}` })),
  ]);
  try {
    const picked = await menuSelect({
      message: title,
      header,
      default: start,
      items: [...items, rule, { value: '', name: back ? '← Back' : 'Quit' }],
    });
    return picked === escaped || !picked ? undefined : picked;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ExitPromptError') throw error;
    console.info(pc.dim('Cancelled.'));
    process.exit(0);
  }
}
