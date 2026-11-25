import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import type { Command } from '../command';
import { onShutdown } from '../utils/signals';

interface InfraOptions {
  words: string[];
}

/** The manifest of the app's `infra` workspace, relative to the app's root. */
export const infraManifest = join('infra', 'package.json');

/**
 * Runs the words in the app's `infra` workspace, whose own CLI parses them and prints the run.
 * @returns its exit code, or 128 plus the number of the signal that ended it
 */
function runInfra(repoRoot: string, words: string[]): Promise<number> {
  const child = spawn('pnpm', ['--silent', '--filter', 'infra', 'cli', ...words], { cwd: repoRoot, stdio: 'inherit' });
  const exited = new Promise<number>((done) => {
    child.once('error', () => done(127));
    child.once('exit', (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
  // Ctrl-C reaches the infra CLI too, which ends its own work first, a stack lease among it: the CLI waits for that
  const release = onShutdown(async () => {
    await exited;
  });
  return exited.finally(release);
}

export const infraCommand: Command<InfraOptions> = {
  name: 'infra',
  group: 'operate',
  description: "set up, apply and deploy the app's environments; `cella infra help` lists its actions",
  inMenu: ({ hasInfra }) => hasInfra,
  handsOver: true,
  jobs: [],
  passthrough: ['words', 'the action and its options, which the infra CLI reads'],
  parse: ({ passthrough }) => ({ words: passthrough }),
  run: async (repoRoot, { words }) => {
    if (!existsSync(join(repoRoot, infraManifest)))
      throw new Error(`this app has no infra workspace: ${infraManifest} is missing`);
    return runInfra(repoRoot, words);
  },
};
