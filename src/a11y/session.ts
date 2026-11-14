import process from 'node:process';
import type { BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { fillPath, type SignedInRun, selectEntries, signIn } from '../utils/app-adapter';
import { newContext, openPage } from '../utils/browser';
import { settle } from '../utils/drive';
import { type A11yState, auditContrast } from './adapter';
import { loadScope, type Scope } from './scope';

export type Mode = 'light' | 'dark';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** A signed-in audit: one browser for every visit, and what each visit starts from. */
export interface AuditSession extends SignedInRun {
  /** Cookies and local storage of a browser that has loaded the app once, as after a real sign-in. */
  storage: StorageState;
  seen: Scope['seen'];
}

/** Elements that exist only in development builds; scans and probes ignore them. */
export const devOnlySelectors = [
  '.TanStackRouterDevtools',
  '.tsqd-parent-container',
  '[aria-label="toggle debug toolbar"]',
];

export const defaultViewport = { width: 1280, height: 900 };

/** Signs the audit user in and loads the app once, for the storage every signed-in visit starts from. */
export async function startAudit(
  repoRoot: string,
  scope: Scope,
  options: { email?: string; env?: NodeJS.ProcessEnv },
): Promise<AuditSession> {
  const run = await signIn(repoRoot, scope, options);
  try {
    // Route guards read the user store, which a real sign-in fills before any deep link is opened
    const context = await newContext(run.browser, { session: run.user });
    const page = await context.newPage();
    await page.goto(`${run.user.frontendUrl}/home`, { waitUntil: 'domcontentloaded' });
    await page.locator('main').first().waitFor({ timeout: 60_000 });
    await settle(page);
    const storage = await context.storageState();
    await context.close();
    return { ...run, storage, seen: scope.seen };
  } catch (error) {
    await run.close();
    throw error;
  }
}

/**
 * A fresh context for one visit: color mode, more contrast, reduced motion, the scope's suppressed UI seen, and signed
 * in when the state needs it. `overrides` change the browser settings, such as the viewport or the motion preference.
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
    uiStore: { slug: session.user.slug, state: { mode, theme: 'none', contrast: auditContrast, ...session.seen } },
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
  { mode = 'light', context: overrides, email }: OpenStateOptions = {},
): Promise<{ page: Page; context: BrowserContext; close: () => Promise<void> }> {
  const repoRoot = process.cwd();
  const scope = await loadScope(repoRoot);
  const [state] = selectEntries(scope.states, [id], 'state');
  const session = await startAudit(repoRoot, scope, { email });
  try {
    const context = await auditContext(session, { auth: state.auth, mode }, { ...state.context, ...overrides });
    const page = await openStatePath(session, context, state);
    await state.open?.(page);
    return { page, context, close: session.close };
  } catch (error) {
    await session.close();
    throw error;
  }
}
