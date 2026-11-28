import { rootPackage } from '../../utils/app';
import { commandTitle, header } from '../../utils/display';
import type { StackState } from '../lib/stack/bootstrap-stack-state';
import type { Environment } from '../lib/stack/environment';
import { pc } from '../lib/utils/cli-output';
import { repoRoot } from '../lib/utils/paths';

/** The environment's name as a sentence shows it: production bold red, staging cyan. */
export function environmentName(environment: Environment): string {
  return environment === 'production' ? pc.bold(pc.red(environment)) : pc.cyan(environment);
}

/** The environment as the title's badge: production white on red, staging black on cyan. */
export function environmentBadge(environment: Environment): string {
  const label = ` ${environment.toUpperCase()} `;
  return environment === 'production' ? pc.bold(pc.bgRed(pc.white(label))) : pc.bold(pc.bgCyan(pc.black(label)));
}

export interface TitleFacts {
  /** The release this checkout is at, left out when the root package.json names none. */
  version?: string;
  environment: Environment;
  state: StackState;
  /** The app's host, from its frontend URL. */
  host?: string;
}

/** The version in the repository's root package.json: the release this checkout is at. */
export function checkoutVersion(): string | undefined {
  try {
    const { version } = rootPackage(repoRoot);
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The lines every run opens with: the package's header, then the command, the environment's badge, the app's host and the checkout's
 * release. The badge makes a production run look unlike a staging run before anything runs.
 */
export function formatHeader(facts: TitleFacts): string {
  const state = facts.state === 'bootstrapped' ? undefined : facts.state === 'fresh' ? 'new' : 'install not finished';
  const details = [facts.host && pc.cyan(facts.host), facts.version && pc.dim(`checkout ${facts.version}`), state && pc.dim(state)];
  const after = details.filter(Boolean).join(pc.dim(' · '));
  return `${header().trimStart()}\n${commandTitle('infra')}   ${environmentBadge(facts.environment)}${after ? `  ${after}` : ''}\n`;
}
