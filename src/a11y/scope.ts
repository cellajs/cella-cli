import type { Page } from 'playwright';
import { z } from 'zod';
import { applyDelta, loadAdapter, mergeSignIn, type SignInSetup } from '../utils/app-adapter';
import { type A11yState, appSchema, baseSchema } from './adapter';

/** The audit scope with the app's delta applied. */
export interface Scope extends SignInSetup {
  sources: string[];
  states: A11yState[];
}

export async function loadScope(repoRoot: string): Promise<Scope> {
  const { base, app } = await loadAdapter(repoRoot, 'a11y', baseSchema, appSchema);
  return {
    ...mergeSignIn(base, app),
    sources: base.sources,
    states: applyDelta(base.states, app, 'cella/a11y.app.ts'),
  };
}

/** The part of the app's config the audit and the report read. */
export const appConfigSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  supportEmail: z.string(),
  frontendUrl: z.string(),
  company: z.object({ name: z.string() }),
  languageCodes: z.array(z.string()).min(1),
  defaultLanguageCode: z.string(),
  enabledAuthStrategies: z.array(z.string()),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

/** Overlays that hold focus while open. Toasts render as dialogs but never take focus. */
export const overlaySelector =
  '[role="dialog"]:not([data-slot^="toast"]), [role="alertdialog"]:not([data-slot^="toast"]), [role="menu"], [role="listbox"]';

/** Opens the state's overlay again when a check (a resize, an Escape) closed it. */
export async function ensureOpen(page: Page, state: A11yState): Promise<void> {
  if (!state.overlay || !state.open || (await page.locator(overlaySelector).count())) return;
  await state.open(page);
}
