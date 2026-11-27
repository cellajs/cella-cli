import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environments } from '../lib/stack/environment';
import { owedWork, owedWorkLines, type PrivilegedFootprint } from '../lib/stack/privileged-footprint';
import { stackFilePath } from '../lib/stack/project-per-mode';
import { getFlag } from '../lib/utils/args';
import { engineTaskCommand } from '../lib/utils/engine-task';
import { errorMessage } from '../lib/utils/errors';
import { repoRoot } from '../lib/utils/paths';

const renderTask = 'privileged-footprint';
const renderFile = join('tasks', 'privileged-footprint.ts');

/** A command line and the folder it runs in. */
interface RenderCommand {
  argv: [string, ...string[]];
  cwd: string;
}

/**
 * How a checkout renders its footprint with its own engine: by the engine's task when it keeps its infra in `cella/infra/`, else by the
 * script of its `infra` workspace, else by the file a base from before the script names.
 * @returns undefined when the checkout can do none of these
 */
function renderCommand(root: string): RenderCommand | undefined {
  if (existsSync(join(root, 'cella', 'infra', 'description.yml'))) return { argv: engineTaskCommand(root, renderTask), cwd: root };
  const workspace = join(root, 'infra');
  const manifestPath = join(workspace, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest: { scripts?: Record<string, string> } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.scripts?.[renderTask]) return { argv: ['pnpm', '--silent', 'run', renderTask], cwd: workspace };
  if (existsSync(join(workspace, renderFile))) return { argv: ['pnpm', '--silent', 'exec', 'tsx', renderFile], cwd: workspace };
  return undefined;
}

/** Render one environment's footprint in a checkout, in a process of its own: the program's modules hold its state. */
function render({ argv: [command, ...args], cwd }: RenderCommand, mode: string, out: string): PrivilegedFootprint {
  const run = spawnSync(command, [...args, '--mode', mode, '--out', out], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`the keyless render of ${mode} in ${cwd} failed:\n${run.stderr.trim().split('\n').slice(-12).join('\n')}`);
  return JSON.parse(readFileSync(out, 'utf8')) as PrivilegedFootprint;
}

/**
 * The pull request check that needs no key: render, for every environment with a stack file, what the base and the head declare that only
 * an Owner moment or an apply writes, and say what merging owes. It passes either way, as owing an apply is no fault; a head that does not
 * render fails it. `--base` is a checkout of the base commit with its dependencies installed. Whether the release PR deploys without an apply
 * is release-applied-check.ts.
 */
export async function main(words: string[]): Promise<void> {
  const baseRoot = getFlag(words, '--base');
  if (!baseRoot) throw new Error('Usage: privileged-check --base <checkout of the base commit>');
  const work = mkdtempSync(join(tmpdir(), 'privileged-check-'));
  const lines: string[] = ['### Privileged changes', ''];
  let owes = false;
  let uncompared = false;
  const headCommand = { argv: engineTaskCommand(repoRoot, renderTask), cwd: repoRoot };
  const baseCommand = renderCommand(baseRoot);
  for (const mode of environments.filter((mode) => existsSync(stackFilePath(mode)))) {
    const head = render(headCommand, mode, join(work, `head-${mode}.json`));
    if (!baseCommand) {
      lines.push(`**${mode}:** the base cannot render what it declares without a key, so there is nothing to compare with.`, '');
      uncompared = true;
      continue;
    }
    let base: PrivilegedFootprint;
    try {
      base = render(baseCommand, mode, join(work, `base-${mode}.json`));
    } catch (error) {
      lines.push(`**${mode}:** the base did not render, so there is nothing to compare with.`, '');
      console.error(errorMessage(error));
      uncompared = true;
      continue;
    }
    const owed = owedWork(base, head);
    lines.push(...owedWorkLines(owed), '');
    if (owed.ownerMoment.length > 0 || owed.apply.length > 0) {
      owes = true;
      if (process.env.GITHUB_ACTIONS) {
        const what = [owed.ownerMoment.length > 0 ? 'an Owner moment' : '', owed.apply.length > 0 ? 'an apply' : ''].filter(Boolean).join(' and ');
        console.info(`::warning title=Privileged change::${mode} needs ${what} before its next deploy; the job summary lists what changes.`);
      }
    }
  }
  if (!owes && !uncompared) lines.push('A deploy can take this change as it is.');
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
