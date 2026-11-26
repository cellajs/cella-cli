import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pc from '../utils/colors';
import { checkMark } from '../utils/display';
import { batchRestoreWorktreeFromRef, git, listIdenticalToRef, maxBuffer, noHooks } from '../utils/git';
import { alignmentsDir, readAlignment } from './alignments';

/** Where `align run` writes an alignment folder: inside the app, so a codemod resolves the app's packages. */
const extractDir = 'node_modules/.cache/cella/alignments';

/** How many restored paths `align run` lists before it cuts the list short. */
const restoredListMax = 20;

/** Write an alignment's folder under {@link extractDir}, byte for byte; returns the folder, relative to the app. */
async function writeAlignmentFolder(repoRoot: string, ref: string, id: string): Promise<string> {
  const files = (await git(['ls-tree', '-r', '--name-only', `${ref}:${alignmentsDir}/${id}`], repoRoot)).split('\n').filter(Boolean);
  const target = join(extractDir, id);
  for (const file of files) {
    // Byte for byte: the git helper trims its output.
    const content = execFileSync('git', [...noHooks, 'show', `${ref}:${alignmentsDir}/${id}/${file}`], {
      cwd: repoRoot,
      maxBuffer,
    });
    const path = join(repoRoot, target, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return target;
}

/**
 * Run the alignment's codemod with `tsx` from the app root, `codemodArgs` after its script (an
 * inventory over its roots when empty), then restore the files it changed that were identical to
 * `ref`, the upstream commit the app last upgraded to. This is `align run <id>`: the codemod runs from
 * a copy extracted inside the app. The restore runs after a failed codemod too: one that stopped
 * halfway may have rewritten files already.
 * @returns 1 when the codemod failed
 * @throws for an unknown alignment and for one without a codemod script
 */
export async function runAlignment(repoRoot: string, ref: string, id: string, codemodArgs: string[]): Promise<number> {
  const alignment = await readAlignment(repoRoot, ref, id);
  if (!alignment) throw new Error(`no alignment '${id}' at upstream ${ref.slice(0, 7)}`);
  if (!alignment.codemod) {
    throw new Error(`alignment '${id}' ships no codemod script: its steps are manual, read them with \`pnpm cella align show ${id}\`.`);
  }
  const script = join(await writeAlignmentFolder(repoRoot, ref, id), alignment.codemod);
  const args = codemodArgs.length > 0 ? codemodArgs : ['inventory', ...alignment.roots];
  const identical = await listIdenticalToRef(repoRoot, ref);

  console.info(pc.dim(`running pnpm exec tsx ${script} ${args.join(' ')}`));
  console.info();
  const child = spawnSync('pnpm', ['exec', 'tsx', script, ...args], { cwd: repoRoot, stdio: 'inherit' });
  if (child.error) throw new Error(`could not run the codemod: ${child.error.message}`);

  const stillIdentical = await listIdenticalToRef(repoRoot, ref);
  const restored = [...identical].filter((path) => !stillIdentical.has(path)).sort();
  await batchRestoreWorktreeFromRef(repoRoot, ref, restored);

  const upstreamShort = ref.slice(0, 9);
  console.info();
  if (restored.length > 0) {
    console.info(`${checkMark} restored ${restored.length} file(s) to upstream ${upstreamShort}`);
    console.info(pc.dim('  the codemod changed them, and they were identical to upstream before the run:'));
    for (const path of restored.slice(0, restoredListMax)) console.info(pc.dim(`    ${path}`));
    if (restored.length > restoredListMax) console.info(pc.dim(`    ... + ${restored.length - restoredListMax} more`));
  } else {
    console.info(pc.dim(`no file identical to upstream ${upstreamShort} was changed by the codemod.`));
  }

  if (child.status !== 0) {
    console.error(`${pc.red('✗')} the codemod exited with code ${child.status ?? 'unknown'}`);
    return 1;
  }
  if (codemodArgs.length === 0) {
    const apply = ['rewrite', ...alignment.roots].join(' ');
    console.info(pc.dim(`report only. to apply: pnpm cella align run ${id} -- ${apply}`));
  }
  return 0;
}
