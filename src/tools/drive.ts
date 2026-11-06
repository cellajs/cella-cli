import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { importFromWorkspace } from '../utils/app-facts';

export type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';

export type Playwright = typeof import('playwright');

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
  forkPath?: string;
  /** The environment the mint script runs in: a testbed's names its database. Default this process's. */
  env?: NodeJS.ProcessEnv;
  /** Session lifetime; default 2. */
  hours?: number;
}

/** Playwright as the app's frontend installed it, so the CLI ships none. */
export function loadPlaywright(forkPath = process.cwd()): Promise<Playwright> {
  return importFromWorkspace<Playwright>(forkPath, 'frontend', 'playwright');
}

/**
 * Checks that Playwright has its Chromium, before anything slow starts.
 * @throws with the install command when it has none
 */
export async function requireChromium(forkPath = process.cwd()): Promise<void> {
  const { chromium } = await loadPlaywright(forkPath);
  if (!existsSync(chromium.executablePath())) {
    throw new Error('Playwright has no Chromium yet: run `pnpm --filter frontend exec playwright install chromium`');
  }
}

/**
 * Signs `email` in through the backend's `session:mint` script, which refuses outside development and test. The script
 * prints `<cookie name>=<signed value>` and a curl line with the API URL, both from the config of the environment it runs
 * in, so a testbed's shifted ports and a linked worktree's are written down nowhere.
 * @throws when the script prints no session, as for an email with no user
 */
export function mintSession(email: string, { forkPath = process.cwd(), env, hours = 2 }: MintOptions = {}): Session {
  const minted = spawnSync('pnpm', ['--silent', '--filter', 'backend', 'session:mint', email, String(hours)], {
    cwd: forkPath,
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

export interface ContextOptions extends BrowserContextOptions {
  /** Signs the context in. */
  session?: Session;
  /**
   * Fields written into the app's persisted UI store (`<slug>-ui`) before any page script runs, so the first paint is
   * already in the mode they set. Merged into what the store holds: a list joins the stored one, any other value wins.
   */
  uiStore?: { slug: string; state: Record<string, unknown> };
}

/** A browser context, signed in and with its UI store seeded when asked. */
export async function newContext(
  browser: Browser,
  { session, uiStore, ...options }: ContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  // tsx and esbuild's keepNames wrap named functions in an `__name` helper that a page script does not have
  await context.addInitScript({ content: 'window.__name = (fn) => fn;' });
  if (session) await context.addCookies([session.cookie]);
  if (uiStore) {
    await context.addInitScript(
      ([key, fields]) => {
        const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
        const state = { ...stored.state };
        for (const [name, value] of Object.entries(fields)) {
          const before = state[name];
          state[name] = Array.isArray(value) && Array.isArray(before) ? [...new Set([...before, ...value])] : value;
        }
        // A fresh entry needs the store's own version, or zustand drops it as written by an older build
        localStorage.setItem(key, JSON.stringify({ version: 1, ...stored, state }));
      },
      [`${uiStore.slug}-ui`, uiStore.state] as const,
    );
  }
  return context;
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

/**
 * Opens `url` in a new page and settles once the route has rendered its content.
 * @throws when the route redirects: a check or a shot would judge another page under this one's name
 */
export async function openPage(context: BrowserContext, url: string, { timeout = 30_000 } = {}): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.locator('main, [role="main"], #accessibility-content, form, h1, footer').first().waitFor({ timeout });
  await settle(page);
  const landed = new URL(page.url()).pathname;
  const asked = new URL(url).pathname;
  if (landed !== asked) throw new Error(`${asked} redirected to ${landed}`);
  return page;
}
