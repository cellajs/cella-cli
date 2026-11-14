/**
 * The CLI version upstream asks for.
 *
 * An upgrade bumps the app's `@cellajs/cli` along with its other packages, so each upgrade runs on the
 * CLI from before it. A fix to analyze or upgrade would reach an app one upgrade late, and that run
 * would silently miss what the fix reports. Upstream's root package.json names the CLI it was
 * built with; a run on an older CLI stops before it touches the app.
 */

import { git } from '../utils/git';
import { compareVersions, parseComparableVersion } from '../utils/versions';

const cliPackage = '@cellajs/cli';

/** The `@cellajs/cli` range in upstream's root package.json at `ref`, or null when it names none. */
export async function readUpstreamCliRange(repoPath: string, ref: string): Promise<string | null> {
  const source = await git(['show', `${ref}:package.json`], repoPath, { ignoreErrors: true });
  if (!source) return null;
  try {
    const pkg = JSON.parse(source) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.devDependencies?.[cliPackage] ?? pkg.dependencies?.[cliPackage] ?? null;
  } catch {
    return null;
  }
}

/**
 * The error message when `running` is older than the lowest version `range` admits, else null.
 * A range with no lower bound (`<1.0.0`, `workspace:*`, `link:…`, `a || b`) never blocks.
 */
/**
 * The follow-up line for an app that delays fresh releases (`minimumReleaseAge`): the exact
 * `minimumReleaseAgeExclude` entry that lets the asked-for version install before it ages.
 */
export function releaseAgeExcludeHint(range: string): string {
  const version = range.match(/\d+\S*/)?.[0] ?? range;
  return `  pnpm delays fresh releases (minimumReleaseAge): if the install is refused, add '${cliPackage}@${version}' to minimumReleaseAgeExclude in pnpm-workspace.yaml.`;
}

export function cliVersionMismatch(running: string, range: string): string | null {
  if (/^\s*(<|>(?!=))/.test(range)) return null;
  const required = parseComparableVersion(range);
  const current = parseComparableVersion(running);
  if (!required || !current || compareVersions(current, required) >= 0) return null;
  return [
    `upstream needs ${cliPackage} ${range}, this is ${running}: an older CLI misses fixes to the upgrade itself.`,
    `  update it, commit, then rerun: pnpm add -D -w '${cliPackage}@${range}'`,
  ].join('\n');
}
