import { z } from 'zod';
import { fn, type Placeholders, type Prepare, placeholdersSchema } from '../adapters';
import type { BrowserContextOptions, Page } from '../drive';

type Opener = (page: Page) => Promise<void>;

/** A form probe a state runs on its page. */
export type FormCheck =
  /** Submitting the form empty identifies each error in text (3.3.1). */
  | 'required'
  /** Inputs for the user's own details declare their purpose (1.3.5). */
  | 'personal'
  /** Sign-in fields accept autofill and pasted text (3.3.8). */
  | 'sign-in';

/** A page or state of the audit scope. */
export interface A11yState {
  id: string;
  /** Path on the frontend; a `{name}` placeholder takes the value its resolver returns. */
  path: string;
  auth: boolean;
  /** Brings the page into the state to audit, such as an open dialog. Runs after the page has loaded. */
  open?: Opener;
  /** `open` leaves an overlay (dialog, sheet, menu) open that holds focus until it closes. */
  overlay?: true;
  /** Browser settings of this state's visits, such as a viewport the state only exists at. */
  context?: BrowserContextOptions;
  forms?: FormCheck[];
}

/** `cella/a11y.ts`: the template's scope, synced with the UI it describes. */
export interface A11yBase {
  /** Brings the audit user into the state the pages expect, before the first visit. */
  prepare?: Prepare;
  /** Values for the `{name}` placeholders of the paths, read as the audit user before the first visit. */
  placeholders?: Placeholders;
  /** What the code checks search, as `git grep` pathspecs from the app's root. */
  sources: string[];
  /** The sample of pages and states the audit covers (WCAG-EM steps 2 and 3), in report order. */
  scope: A11yState[];
}

/** `cella/a11y.app.ts`, optional: what an app adds to the base, removes from it or overrides. */
export interface A11yApp {
  /** Runs after the base's. */
  prepare?: Prepare;
  /** Joins the base's; a name in both takes this one. */
  placeholders?: Placeholders;
  /** Base state ids the app does not have. */
  remove?: string[];
  /** States of the app's own; one with a base state's id replaces it in place. */
  add?: A11yState[];
}

const stateSchema = z.strictObject({
  id: z.string().min(1),
  path: z.string().startsWith('/').or(z.string().startsWith('{')),
  auth: z.boolean(),
  open: fn<Opener>().optional(),
  overlay: z.literal(true).optional(),
  context: z.custom<BrowserContextOptions>((value) => typeof value === 'object' && value !== null).optional(),
  forms: z.array(z.enum(['required', 'personal', 'sign-in'])).optional(),
}) satisfies z.ZodType<A11yState>;

export const baseSchema = z.strictObject({
  prepare: fn<Prepare>().optional(),
  placeholders: placeholdersSchema.optional(),
  sources: z.array(z.string()).min(1),
  scope: z.array(stateSchema).min(1),
}) satisfies z.ZodType<A11yBase>;

export const appSchema = z.strictObject({
  prepare: fn<Prepare>().optional(),
  placeholders: placeholdersSchema.optional(),
  remove: z.array(z.string()).optional(),
  add: z.array(stateSchema).optional(),
}) satisfies z.ZodType<A11yApp>;

/**
 * The audit measures the app with increased contrast turned on, which is what raises the edge tokens to 3:1. It is a
 * user setting, not the default, so every report built from a run says so: the ledger records it and the report prints
 * it. `prepare` stores it for the audit user, since `/me` overwrites the seeded UI store on every authenticated page.
 */
export const auditContrast = 'more' as const;

export const defineA11yBase = (base: A11yBase): A11yBase => base;

export const defineA11yApp = (app: A11yApp): A11yApp => app;
