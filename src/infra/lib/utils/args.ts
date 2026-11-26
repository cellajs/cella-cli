/** Tiny CLI arg helpers shared by the tasks and the agent. */

/** Value following `--flag`, or undefined if the flag is absent. */
export function getFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}
