import process from 'node:process';
import { select } from '@inquirer/prompts';
import pc from './colors';
import { menuDivider } from './display';

export interface MenuEntry {
  value: string;
  label: string;
  /** Dim beside the label. */
  description: string;
}

/**
 * A list of the CLI, drawn as the infra CLI draws its menus: an optional bold title, the entries in two columns, a
 * divider and a plain quit row, with no question mark, no key hints and no wrap-around. The page fills the terminal
 * less the title and a spare row. The list erases itself once answered: a command run from it prints under the header,
 * as when it is named on the command line. Every menu leaves the CLI on quit and on ctrl-c: it then says so and
 * resolves to undefined, and the caller ends the run.
 */
export async function pickFromMenu(entries: MenuEntry[], title = ''): Promise<string | undefined> {
  const width = Math.max(...entries.map((entry) => entry.label.length)) + 3;
  try {
    const picked = await select<string>(
      {
        message: title,
        choices: [
          ...entries.map(({ value, label, description }) => ({
            value,
            name: `${label.padEnd(width)}${pc.dim(description)}`,
          })),
          { type: 'separator' as const, separator: menuDivider },
          { value: '', name: 'quit' },
        ],
        pageSize: Math.max(3, (process.stdout.rows || 24) - (title ? 2 : 1)),
        loop: false,
        // An empty message bolds into a line of escape codes alone, which prints as a blank line
        theme: {
          prefix: '',
          style: { keysHelpTip: () => '', message: (text: string) => (text ? pc.bold(text) : '') },
        },
      },
      { clearPromptOnDone: true },
    );
    if (picked) return picked;
    console.info(pc.dim('exiting...'));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ExitPromptError') throw error;
    console.info(pc.dim('Cancelled.'));
  }
  return undefined;
}
