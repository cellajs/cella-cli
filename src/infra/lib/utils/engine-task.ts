import { join } from 'node:path';

/**
 * The command line that runs an engine task in the app at `root`: the bin of the `@cellajs/cli` its `cella` package installs, `infra <task>`
 * and the task's words. Every script and child process of the engine starts a task this way, with the app root as its working directory; a
 * container's script names the root as it mounts it.
 */
export function engineTaskCommand(root: string, task: string, words: readonly string[] = []): [string, ...string[]] {
  return [join(root, 'cella', 'node_modules', '.bin', 'cella'), 'infra', task, ...words];
}
