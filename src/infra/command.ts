import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../command';
import { handOverSignals } from '../utils/signals';
import { infraHelp } from './cli/help';

interface InfraOptions {
  words: string[];
}

/** The manifest of the app's `infra` workspace, relative to the app's root. */
const infraManifest = join('infra', 'package.json');

/** The app's `infra` folder when `dir` is the app's root with an `infra` workspace, or that workspace itself, where its scripts run. */
function infraWorkspace(dir: string): string | undefined {
  if (existsSync(join(dir, infraManifest))) return join(dir, 'infra');
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return undefined;
  const parsed: { name?: unknown } = JSON.parse(readFileSync(manifest, 'utf8'));
  return parsed.name === 'infra' ? dir : undefined;
}

/** Whether `dir` is the app's root with an `infra` workspace, or that workspace itself. */
export function hasInfraWorkspace(dir: string): boolean {
  return infraWorkspace(dir) !== undefined;
}

export const infraCommand: Command<InfraOptions> = {
  name: 'infra',
  group: 'operate',
  description: "set up, apply and deploy the app's environments; `cella infra help` lists its actions",
  summary: 'the deploy console: set up, apply and deploy the environments',
  inMenu: ({ hasInfra }) => hasInfra,
  handsOver: true,
  help: infraHelp,
  // The engine image and the builder run its tasks without a git checkout
  outsideGit: true,
  jobs: [],
  passthrough: ['words', 'an action and its options, or a task the app runs by script'],
  parse: ({ passthrough }) => ({ words: passthrough }),
  run: async (repoRoot, { words }) => {
    const workspace = infraWorkspace(repoRoot);
    if (!workspace) throw new Error(`this app has no infra workspace: ${infraManifest} is missing`);
    if (!existsSync(join(workspace, 'description.yml'))) {
      throw new Error(
        "this app still describes its infra in infra/config/, where the engine reads infra/description.yml. The template's alignment infra-description (cella/alignments/) moves it: `pnpm cella align` lists it after the upgrade.",
      );
    }
    // The engine ends its own work on ctrl-c, a stack lease among it, and then the process
    handOverSignals();
    const { runInfra } = await import('./run');
    return runInfra(words);
  },
};
