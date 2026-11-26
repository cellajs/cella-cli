import { emitKeypressEvents } from 'node:readline';
import inquirerSelect from '@inquirer/select';
import { confirm as confirmPrompt, type InputPromptConfig, input as inputPrompt } from '../../../utils/prompts';
import { recalledAnswer, rememberAnswer } from '../session';

/** Thrown when the operator presses Esc at a prompt: a flow goes back one step, and its first step back to the menu. */
export class PromptBack extends Error {
  constructor() {
    super('the operator stepped back');
    this.name = 'PromptBack';
  }
}

/** The context an Inquirer prompt runs in: its abort signal, and whether it erases itself when it ends. */
export interface PromptContext {
  signal: AbortSignal;
  clearPromptOnDone: boolean;
}

/**
 * Run one prompt so Esc rejects it with {@link PromptBack} and erases it. Inquirer's prompts have no Esc of their own: a keypress
 * listener aborts the prompt through its signal, as menuSelect does; Inquirer reads the erase flag only once the prompt ends. Node 26
 * reports a lone Esc with `meta` set, which the name alone matches.
 */
export async function withBack<T>(ask: (context: PromptContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const context: PromptContext = { signal: controller.signal, clearPromptOnDone: false };
  const onKeypress = (_chunk: unknown, key?: { name?: string }) => {
    if (key?.name !== 'escape') return;
    context.clearPromptOnDone = true;
    controller.abort();
  };
  emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', onKeypress);
  try {
    return await ask(context);
  } catch (error) {
    if (controller.signal.aborted && error instanceof Error && error.name === 'AbortPromptError') throw new PromptBack();
    throw error;
  } finally {
    process.stdin.removeListener('keypress', onKeypress);
  }
}

/**
 * Run a flow's prompts as steps: Esc at a step goes back to the one before, whose prompt offers its earlier answer when it has an `id`, and
 * Esc at the first leaves the flow with {@link PromptBack}.
 */
export async function steps(list: ReadonlyArray<() => Promise<void>>): Promise<void> {
  for (let at = 0; at < list.length; ) {
    try {
      await list[at]?.();
      at++;
    } catch (error) {
      if (!(error instanceof PromptBack) || at === 0) throw error;
      at--;
    }
  }
}

/** A prompt's config with the id its answer is kept under, for a step back or a retry. */
type Recorded<C> = C & { id?: string };

/** A yes/no question that Esc steps back from. With an `id` the answer given earlier in the action is the default. */
export async function confirm(config: Recorded<{ message: string; default?: boolean }>): Promise<boolean> {
  const earlier = config.id === undefined ? undefined : recalledAnswer(config.id);
  const fallback = typeof earlier === 'boolean' ? earlier : config.default !== false;
  const answer = await withBack((context) => confirmPrompt({ message: config.message, default: fallback }, context));
  if (config.id !== undefined) rememberAnswer(config.id, answer);
  return answer;
}

/** A line of text that Esc steps back from. With an `id` the answer given earlier in the action is the default. */
export async function input(config: Recorded<InputPromptConfig>): Promise<string> {
  const earlier = config.id === undefined ? undefined : recalledAnswer(config.id);
  const answer = await withBack((context) =>
    inputPrompt({ message: config.message, default: typeof earlier === 'string' ? earlier : config.default, validate: config.validate }, context),
  );
  if (config.id !== undefined) rememberAnswer(config.id, answer);
  return answer;
}

/** Inquirer's select, which Esc steps back from, without its help line. */
export function select<T>(config: Parameters<typeof inquirerSelect<T>>[0]): Promise<T> {
  return withBack((context) => inquirerSelect<T>({ ...config, theme: { style: { keysHelpTip: () => '' } } }, context));
}
