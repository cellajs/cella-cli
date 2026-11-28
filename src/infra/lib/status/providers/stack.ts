import { check, installAction } from '../check';
import type { StatusProvider } from '../types';

/** The stack file's check; every fact lives on the session. */
export const stackProvider: StatusProvider<Record<string, never>> = {
  domain: 'config',
  async gather() {
    return {};
  },
  evaluate(_facts, session) {
    const stack = check('config.stackState', 'Install');
    return [
      session.stackState === 'fresh'
        ? stack.missing(`no Pulumi.${session.mode}.yaml; this stack has not been installed`, installAction)
        : session.stackState === 'partial'
          ? stack.warn('stack file exists but the install is incomplete (no deploy key)', installAction)
          : { ...stack.ok(`installed (${session.mode})`), headline: `${session.mode} installed` },
    ];
  },
};
