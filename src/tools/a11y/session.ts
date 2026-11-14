import process from 'node:process';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { getEnv } from '../../utils/env';
import { onShutdown } from '../../utils/signals';
import { fillPath, signedIn } from '../adapters';
import { loadPlaywright, mintSession, newContext, openPage, type Session, settle, signOut } from '../drive';
import { type A11yState, auditContrast } from './define';
import { loadScope, type Scope } from './scope';

export type Mode = 'light' | 'dark';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** A signed-in audit: one browser for every visit, and what each visit starts from. */
export interface AuditSession {
  browser: Browser;
  user: Session;
  /** Cookies and local storage of a browser that has loaded the app once, as after a real sign-in. */
  storage: StorageState;
  /** Resolved `{name}` placeholders of the scope paths. */
  values: Record<string, string | null>;
}

/** Elements that exist only in development builds; scans and probes ignore them. */
export const devOnlySelectors = [
  '.TanStackRouterDevtools',
  '.tsqd-parent-container',
  '[aria-label="toggle debug toolbar"]',
];

export const defaultViewport = { width: 1280, height: 900 };

/**
 * Signs the audit user in, runs the scope's `prepare` steps, resolves its placeholders and starts the browser.
 * `env` points the session mint at the database the app runs on.
 */
export async function startAudit(
  forkPath: string,
  scope: Scope,
  { email, env }: { email: string; env?: NodeJS.ProcessEnv },
): Promise<AuditSession> {
  const user = mintSession(email, { forkPath, env, hours: 4 });
  let browser: Browser | undefined;
  // Closes the browser on a signal until the caller registers endAudit
  const forget = onShutdown(() => browser?.close());
  try {
    for (const prepare of scope.prepare) await prepare(signedIn(user));
    const values: AuditSession['values'] = {};
    for (const [name, resolve] of Object.entries(scope.placeholders)) values[name] = await resolve(signedIn(user));

    const { chromium } = await loadPlaywright(forkPath);
    browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false });
    // Route guards read the user store, which a real sign-in fills before any deep link is opened
    const context = await newContext(browser, { session: user });
    const page = await context.newPage();
    await page.goto(`${user.frontendUrl}/home`, { waitUntil: 'domcontentloaded' });
    await page.locator('main').first().waitFor({ timeout: 60_000 });
    await settle(page);
    const storage = await context.storageState();
    await context.close();
    return { browser, user, storage, values };
  } catch (error) {
    await signOut(user);
    throw error;
  } finally {
    forget();
  }
}

/** Closes the browser and signs the audit user out, so a finished audit leaves no live session behind. */
export async function endAudit(session: AuditSession): Promise<void> {
  await session.browser.close();
  await signOut(session.user);
}

/**
 * A fresh context for one visit: color mode, more contrast, reduced motion, the dev banner dismissed, and signed in
 * when the state needs it. `overrides` change the browser settings, such as the viewport or the motion preference.
 */
export function auditContext(
  session: AuditSession,
  { auth, mode }: { auth: boolean; mode: Mode },
  overrides: BrowserContextOptions = {},
): Promise<BrowserContext> {
  return newContext(session.browser, {
    viewport: defaultViewport,
    colorScheme: mode,
    // Emulates `prefers-contrast`, which tailwind.css answers on its own, so public pages are covered like signed-in ones
    contrast: 'more',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    storageState: auth ? session.storage : undefined,
    // `contrast` here is what the app's own `data-contrast` path reads; the context option above covers the media query
    uiStore: {
      slug: session.user.slug,
      state: { mode, theme: 'none', contrast: auditContrast, publicAlertsSeen: ['test-credentials'] },
    },
    ...overrides,
  });
}

/** Opens a state's path in `context`; its `open` step is the caller's. */
export function openStatePath(session: AuditSession, context: BrowserContext, state: A11yState): Promise<Page> {
  const path = fillPath(state.path, session.values, 'the a11y adapter');
  return openPage(context, `${session.user.frontendUrl}${path}`);
}

interface OpenStateOptions {
  mode?: Mode;
  /** Over the state's own browser settings, such as a phone or `{ reducedMotion: 'no-preference' }`. */
  context?: BrowserContextOptions;
  /** Default `ADMIN_EMAIL`, which a testbed hands the command it runs. */
  email?: string;
}

/**
 * Opens a state of the app's audit scope by id, signed in: the start of a short script that checks a fix in the
 * running app. Run the script from the app's root through `pnpm testbed -- node <script>`; `close` ends it.
 * @throws when the scope has no state of that id, or no email is given and `ADMIN_EMAIL` is unset
 */
export async function openState(
  id: string,
  { mode = 'light', context: overrides, email = getEnv('ADMIN_EMAIL') }: OpenStateOptions = {},
): Promise<{ page: Page; context: BrowserContext; close: () => Promise<void> }> {
  if (!email) throw new Error('no email: pass one, or run through `pnpm testbed --`, which sets ADMIN_EMAIL');
  const forkPath = process.cwd();
  const scope = await loadScope(forkPath);
  const state = scope.states.find((candidate) => candidate.id === id);
  if (!state) throw new Error(`no state "${id}" in the a11y scope`);
  const session = await startAudit(forkPath, scope, { email });
  try {
    const context = await auditContext(session, { auth: state.auth, mode }, { ...state.context, ...overrides });
    const page = await openStatePath(session, context, state);
    await state.open?.(page);
    return { page, context, close: () => endAudit(session) };
  } catch (error) {
    await endAudit(session);
    throw error;
  }
}
