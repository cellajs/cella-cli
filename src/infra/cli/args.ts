import { isOperatorActionId, type OperatorActionId } from '../lib/operator-actions';

/** What the command line of `pnpm cella infra` asks for. */
export interface CliArgs {
  /** The action to run without the menu: `pnpm cella infra <action>`. */
  action?: OperatorActionId;
  /** A first word that names no action; the CLI lists the ones that exist. */
  unknownAction?: string;
  /** `--mode <production|staging>`; the CLI refuses any other value as a usage error before it resolves the mode. */
  mode?: string;
  /** `--once`: leave after the first action chosen in the menu. */
  once: boolean;
  /** `help`, `--help` or `-h`: print the commands and leave. */
  help: boolean;
  /** Why the engine refuses this command line: an unknown flag, a flag without its value, or a second word. */
  refusal?: string;
  /** The package menu opened the CLI: the menu ends on `← Back`, which hands the run back to it. No word sets it. */
  back?: boolean;
}

/** Flags that take the next word as their value, so that word is never read as the action. */
const valueFlags = new Set(['--mode', '--sha']);
/** Every flag the engine and its actions read. */
const knownFlags = new Set([...valueFlags, '--once', '--help', '-h', '--defaults', '--debug-provider', '--machines']);
/** The flags one action alone reads: on another action they would pass unread. The menu takes them for the action it starts. */
const flagOwner: Record<string, OperatorActionId> = { '--sha': 'logs', '--machines': 'logs', '--debug-provider': 'apply' };

/** The command line with each `--flag=value` of a flag that takes a value split into `--flag value`. */
export function splitFlagValues(argv: readonly string[]): string[] {
  return argv.flatMap((token) => {
    const at = token.indexOf('=');
    return at > 0 && valueFlags.has(token.slice(0, at)) ? [token.slice(0, at), token.slice(at + 1)] : [token];
  });
}

/**
 * Read the command line (everything after the script). The first word that is no flag and no flag value names the action. Flags the
 * actions read on their own (`--defaults`, `--debug-provider`, `--sha`, `--machines`) pass through untouched.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { once: false, help: false };
  const tokens = splitFlagValues(argv);
  const words: string[] = [];
  const flags: string[] = [];
  let unknown: string | undefined;
  let valueless: string | undefined;
  let twice: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    const value = tokens[index + 1];
    if (!token.startsWith('-')) {
      words.push(token);
      continue;
    }
    if (valueFlags.has(token) && flags.includes(token)) twice ??= token;
    flags.push(token);
    if (!knownFlags.has(token)) unknown ??= token;
    else if (valueFlags.has(token) && (!value || value.startsWith('-'))) valueless ??= token;
    else if (valueFlags.has(token)) {
      if (token === '--mode') args.mode ??= value;
      index++;
    } else if (token === '--once') args.once = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  const [word, extra] = words;
  const command = word === undefined ? 'infra' : `infra ${word}`;
  const misplaced = word === undefined ? undefined : flags.find((flag) => flagOwner[flag] !== undefined && flagOwner[flag] !== word);
  if (unknown) args.refusal = `unknown option '${unknown}' for ${command}`;
  else if (valueless) args.refusal = `option '${valueless}' needs a value`;
  else if (twice) args.refusal = `option '${twice}' is given twice`;
  else if (extra !== undefined) args.refusal = `unexpected word '${extra}' after ${command}`;
  else if (misplaced) args.refusal = `option '${misplaced}' belongs to infra ${flagOwner[misplaced]}, not to ${command}`;
  if (word === 'help') args.help = true;
  else if (word !== undefined && isOperatorActionId(word)) args.action = word;
  else if (word !== undefined) args.unknownAction = word;
  return args;
}
