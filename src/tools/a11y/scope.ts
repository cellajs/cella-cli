import type { Page } from 'playwright';
import { z } from 'zod';
import { importFromApp } from '../../utils/app-facts';
import { setEnv } from '../../utils/env';
import { applyDelta, loadAdapter, type Placeholders, type Prepare } from '../adapters';
import { type A11yState, appSchema, baseSchema } from './define';

/** The audit scope with the app's delta applied. */
export interface Scope {
  /** The base's, then the delta's. */
  prepare: Prepare[];
  placeholders: Placeholders;
  sources: string[];
  states: A11yState[];
}

export async function loadScope(forkPath: string): Promise<Scope> {
  // The adapters read the app config, which takes the development ports and URLs in development mode only
  setEnv('NODE_ENV', 'development');
  const { base, app } = await loadAdapter(forkPath, 'a11y', baseSchema, appSchema);
  return {
    prepare: [base.prepare, app?.prepare].filter((step) => step !== undefined),
    placeholders: { ...base.placeholders, ...app?.placeholders },
    sources: base.sources,
    states: app ? applyDelta(base.scope, app, 'cella/a11y.app.ts') : base.scope,
  };
}

const appConfigSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  supportEmail: z.string(),
  frontendUrl: z.string(),
  company: z.object({ name: z.string() }),
  languages: z.array(z.string()).min(1),
  defaultLanguage: z.string(),
  enabledAuthStrategies: z.array(z.string()),
});

/** The part of the app's config the audit and the report read. */
export type AppConfig = z.infer<typeof appConfigSchema>;

/** The app's config in `mode`: the report describes the production app, the audit runs against development builds. */
export async function loadAppConfig(forkPath: string, mode: 'development' | 'production'): Promise<AppConfig> {
  setEnv('NODE_ENV', mode);
  const parsed = appConfigSchema.safeParse((await importFromApp(forkPath, 'shared/index.ts')).appConfig);
  if (!parsed.success)
    throw new Error(`shared/index.ts exports no appConfig the audit can read: ${parsed.error.message}`);
  return parsed.data;
}

/** Overlays that hold focus while open. Toasts render as dialogs but never take focus. */
export const overlaySelector =
  '[role="dialog"]:not([data-slot^="toast"]), [role="alertdialog"]:not([data-slot^="toast"]), [role="menu"], [role="listbox"]';

/** Opens the state's overlay again when a check (a resize, an Escape) closed it. */
export async function ensureOpen(page: Page, state: A11yState): Promise<void> {
  if (!state.overlay || !state.open || (await page.locator(overlaySelector).count())) return;
  await state.open(page);
}
