import { existsSync } from 'node:fs';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { loadPlaywright, type Session, settle } from './drive';
import { onShutdown } from './signals';

/**
 * Checks that Playwright has its Chromium, before anything slow starts.
 * @throws with the install command when it has none
 */
export async function requireChromium(repoRoot: string): Promise<void> {
  const { chromium } = await loadPlaywright(repoRoot);
  if (!existsSync(chromium.executablePath())) {
    throw new Error('Playwright has no Chromium yet: run `pnpm --filter frontend exec playwright install chromium`');
  }
}

/** Chromium from the app's Playwright, which ctrl-c closes until it is closed. */
export async function launchBrowser(repoRoot: string): Promise<Browser> {
  const { chromium } = await loadPlaywright(repoRoot);
  // Playwright's own signal handlers would end the browser before the CLI's cleanups run
  const browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false });
  const forget = onShutdown(() => browser.close());
  browser.once('disconnected', forget);
  return browser;
}

interface ContextOptions extends BrowserContextOptions {
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
