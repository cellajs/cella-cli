import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../command';
import { handOverSignals } from '../utils/signals';

interface InfraOptions {
  words: string[];
}

/** The manifest of the app's `infra` workspace, relative to the app's root. */
export const infraManifest = join('infra', 'package.json');

/** Whether `dir` is the app's root with an `infra` workspace, or that workspace itself, where its scripts run. */
export function hasInfraWorkspace(dir: string): boolean {
  if (existsSync(join(dir, infraManifest))) return true;
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return false;
  const parsed: { name?: unknown } = JSON.parse(readFileSync(manifest, 'utf8'));
  return parsed.name === 'infra';
}

export const infraCommand: Command<InfraOptions> = {
  name: 'infra',
  group: 'operate',
  description: "set up, apply and deploy the app's environments; `cella infra help` lists its actions",
  inMenu: ({ hasInfra }) => hasInfra,
  handsOver: true,
  // The engine image and the builder run its tasks without a git checkout
  outsideGit: true,
  jobs: [],
  passthrough: ['words', 'an action and its options, or a task the app runs by script'],
  parse: ({ passthrough }) => ({ words: passthrough }),
  run: async (repoRoot, { words }) => {
    if (!hasInfraWorkspace(repoRoot)) throw new Error(`this app has no infra workspace: ${infraManifest} is missing`);
    // The engine ends its own work on ctrl-c, a stack lease among it, and then the process
    handOverSignals();
    const { runInfra } = await import('./run');
    return runInfra(words);
  },
};
