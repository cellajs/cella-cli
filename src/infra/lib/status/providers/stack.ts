import { check, setupAction } from '../check';
import type { StatusProvider } from '../types';

/** The stack file's check; every fact lives on the session. */
export const stackProvider: StatusProvider<Record<string, never>> = {
  domain: 'config',
  async gather() {
    return {};
  },
  evaluate(_facts, session) {
    const stack = check('config.stackState', 'Setup');
    return [
      session.stackState === 'fresh'
        ? stack.missing(`no Pulumi.${session.mode}.yaml; this stack has not been set up`, setupAction)
        : session.stackState === 'partial'
          ? stack.warn('stack file exists but bootstrap is incomplete (no deploy key)', setupAction)
          : { ...stack.ok(`bootstrapped (${session.mode})`), headline: `${session.mode} set up` },
    ];
  },
};
