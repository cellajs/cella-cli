import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from '../command';
import { handOverSignals, installSignalHandlers } from '../utils/signals';
import { infraHelp } from './cli/help';

interface InfraOptions {
  words: string[];
  /** The package menu opened the engine: its menu ends on `← Back`, which returns to the package menu. */
  back: boolean;
}

/** The app's description, relative to its root. */
const description = join('cella', 'infra', 'description.yml');

/**
 * Whether `dir` is an app root with infra, or its `cella/infra` folder, where Pulumi runs the program. An app that keeps its infra in
 * `infra/` counts, and so does the app's `cella` folder: the engine's start refuses the one with the alignment that moves it, the other with
 * the app's root.
 */
export function hasInfraFolder(dir: string): boolean {
  const infra = join(dir, 'infra');
  if (existsSync(join(dir, description)) || existsSync(join(infra, 'package.json')) || existsSync(join(infra, 'description.yml'))) return true;
  const up = resolve(dir, '..', '..');
  return resolve(dir) === join(up, 'cella', 'infra') && existsSync(join(up, description));
}

export const infraCommand: Command<InfraOptions> = {
  name: 'infra',
  group: 'operate',
  description: "install, apply and deploy the app's environments; `cella infra help` lists its actions",
  summary: 'the deploy console: install, apply and deploy the environments',
  inMenu: ({ hasInfra }) => hasInfra,
  handsOver: true,
  help: infraHelp,
  // The engine image and the builder run its tasks without a git checkout
  outsideGit: true,
  jobs: [],
  passthrough: ['words', 'an action and its options, or a task by its name'],
  parse: ({ passthrough, menu }) => ({ words: passthrough, back: menu === true }),
  run: async (dir, { words, back }) => {
    if (!hasInfraFolder(dir)) throw new Error(`this app has no infra: ${description} is missing`);
    // The engine finds the app root from the working directory: this folder, or two up when it is the cella/infra folder
    process.chdir(dir);
    // Refuses a root without cella/infra/description.yml before any of the engine loads
    await import('./lib/utils/paths');
    // The engine ends its own work on ctrl-c, a stack lease among it, and then the process
    handOverSignals();
    const { runInfra } = await import('./run');
    const code = await runInfra(words, { back });
    // Back in the package menu, ctrl-c runs the cleanups of the package's commands again
    if (back) installSignalHandlers();
    return code;
  },
};
