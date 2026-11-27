/** Sets `APP_MODE` from `--mode`, or keeps the one set. False, after printing `usage`, when neither names a mode. */
function setMode(words: string[], usage: string): boolean {
  const modeIndex = words.indexOf('--mode');
  const mode = modeIndex >= 0 ? words[modeIndex + 1] : process.env.APP_MODE;
  if (!mode) {
    console.error(`Usage: ${usage} (or APP_MODE)`);
    return false;
  }
  process.env.APP_MODE = mode;
  return true;
}

/**
 * The hash of this checkout's description of the app for one environment, printed alone on stdout: what an apply records, the engine
 * image's build checks and a builder reports from the target's checkout, keyless. APP_MODE is set before the config loads, as deploy.ts does.
 * With --json it prints the description itself as the canonical text the hash is taken of, which a builder puts in the manifest beside it.
 * @returns 1 without `--mode` or APP_MODE
 */
export async function main(words: string[]): Promise<number> {
  if (!setMode(words, 'description-hash --mode <staging|production> [--json]')) return 1;
  const [{ appDescription, appDescriptionHash }, { canonicalJson }] = await Promise.all([
    import('../lib/deploy/app-description'),
    import('../lib/deploy/applied-engine'),
  ]);
  process.stdout.write(`${words.includes('--json') ? canonicalJson(await appDescription()) : await appDescriptionHash()}\n`);
  return 0;
}

/**
 * The description of the app for one environment, indented for a reader: the canonical text `description-hash --json` prints on one line.
 * @returns 1 without `--mode` or APP_MODE
 */
export async function printDescription(words: string[]): Promise<number> {
  if (!setMode(words, 'description --mode <staging|production>')) return 1;
  const [{ appDescription }, { canonicalJson }] = await Promise.all([
    import('../lib/deploy/app-description'),
    import('../lib/deploy/applied-engine'),
  ]);
  process.stdout.write(`${JSON.stringify(JSON.parse(canonicalJson(await appDescription())), null, 2)}\n`);
  return 0;
}
