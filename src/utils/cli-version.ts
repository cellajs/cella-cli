/**
 * The CLI version upstream asks for.
 *
 * A sync bumps the fork's `@cellajs/cli` along with its other packages, so each sync runs on the
 * CLI from before it. A fix to analyze or sync would reach a fork one sync late, and that run
 * would silently miss what the fix reports. Upstream's root package.json names the CLI it was
 * built with; a run on an older CLI stops before it touches the fork.
 */

import { git } from './git';
import { compareVersions, parseComparableVersion } from './versions';

const CLI_PACKAGE = '@cellajs/cli';

/** The `@cellajs/cli` range in upstream's root package.json at `ref`, or null when it names none. */
export async function readUpstreamCliRange(repoPath: string, ref: string): Promise<string | null> {
  const source = await git(['show', `${ref}:package.json`], repoPath, { ignoreErrors: true });
  if (!source) return null;
  try {
    const pkg = JSON.parse(source) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.devDependencies?.[CLI_PACKAGE] ?? pkg.dependencies?.[CLI_PACKAGE] ?? null;
  } catch {
    return null;
  }
}

/**
 * The error message when `running` is older than the lowest version `range` admits, else null.
 * A range with no lower bound (`<1.0.0`, `workspace:*`, `link:…`, `a || b`) never blocks.
 */
export function cliVersionMismatch(running: string, range: string): string | null {
  if (/^\s*(<|>(?!=))/.test(range)) return null;
  const required = parseComparableVersion(range);
  const current = parseComparableVersion(running);
  if (!required || !current || compareVersions(current, required) >= 0) return null;
  return [
    `upstream needs ${CLI_PACKAGE} ${range}, this is ${running}: an older CLI misses fixes to the sync itself.`,
    `  update it, commit, then rerun: pnpm add -D -w '${CLI_PACKAGE}@${range}'`,
  ].join('\n');
}
