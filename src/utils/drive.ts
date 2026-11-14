import { spawnSync } from 'node:child_process';
import process from 'node:process';
import type { Page } from 'playwright';
import { importFromWorkspace } from './app';

type Playwright = typeof import('playwright');

/** A signed-in user of the app: where it answers and the cookie that signs a browser or a request in. */
export interface Session {
  email: string;
  frontendUrl: string;
  /** The API, a path under the frontend's origin. */
  backendUrl: string;
  /** The app's slug, read off the cookie name; the persisted UI store's key starts with it. */
  slug: string;
  /** In the shape `context.addCookies` takes. */
  cookie: { name: string; value: string; url: string; httpOnly: true; sameSite: 'Strict' };
  /** `name=value`, for a request's cookie header. */
  header: string;
}

export interface MintOptions {
  /** The app's root; default the current directory. */
  repoRoot?: string;
  /** The environment the mint script runs in: a testbed's names its database. Default this process's. */
  env?: NodeJS.ProcessEnv;
  /** Session lifetime; default 2. */
  hours?: number;
}

/** Playwright as the app's frontend installed it, so the CLI ships none. */
export function loadPlaywright(repoRoot = process.cwd()): Promise<Playwright> {
  return importFromWorkspace<Playwright>(repoRoot, 'frontend', 'playwright');
}

/**
 * Signs `email` in through the backend's `session:mint` script, which refuses outside development and test. The script
 * prints `<cookie name>=<signed value>` and a curl line with the API URL, both from the config of the environment it runs
 * in, so a testbed's shifted ports and a linked worktree's are written down nowhere.
 * @throws when the script prints no session, as for an email with no user
 */
export function mintSession(email: string, { repoRoot = process.cwd(), env, hours = 2 }: MintOptions = {}): Session {
  const minted = spawnSync('pnpm', ['--silent', '--filter', 'backend', 'session:mint', email, String(hours)], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const cookie = /^((?:__Host-)?([\w-]+)-session-v\d+)=(\S+)$/m.exec(minted.stdout);
  const api = /^curl (\S+)\/me /m.exec(minted.stdout);
  if (!cookie || !api) throw new Error(`could not mint a session for ${email}:\n${minted.stdout}\n${minted.stderr}`);
  const frontendUrl = new URL(api[1]).origin;
  return {
    email,
    frontendUrl,
    backendUrl: api[1],
    slug: cookie[2],
    cookie: { name: cookie[1], value: cookie[3], url: frontendUrl, httpOnly: true, sameSite: 'Strict' },
    header: `${cookie[1]}=${cookie[3]}`,
  };
}

/**
 * Signs a minted session out, so a finished run leaves no live session in the user's sessions list. A JSON content type
 * passes the CSRF check without an Origin header; a stack that is already down leaves the session to expire.
 */
export async function signOut(session: Session | null | undefined): Promise<void> {
  if (!session) return;
  const headers = { cookie: session.header, 'content-type': 'application/json' };
  await fetch(`${session.backendUrl}/auth/sign-out`, { method: 'POST', headers }).catch(() => {});
}

/**
 * Resolves once the page has stopped adding or changing content for `quiet` ms, or after `cap` ms. Lazy sections, query
 * results and opening overlays all show up as DOM changes; the network never goes idle in development.
 */
export async function settle(page: Page, { quiet = 400, cap = 3000 } = {}): Promise<void> {
  const waited = page.evaluate(
    ([quietMs, capMs]) =>
      new Promise<void>((resolve) => {
        const done = () => {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(limit);
          resolve();
        };
        let timer = setTimeout(done, quietMs);
        const limit = setTimeout(done, capMs);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quietMs);
        });
        observer.observe(document, { subtree: true, childList: true, characterData: true });
      }),
    [quiet, cap] as const,
  );
  // A navigation during the wait tears down the page's script context
  await waited.catch(() => page.waitForTimeout(quiet));
}
