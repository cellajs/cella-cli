import { z } from 'zod';
import { fn, type Placeholders, type Prepare, placeholdersSchema } from '../adapters';
import type { Page } from '../drive';

type Opener = (page: Page) => Promise<void>;

/** A viewport and its pixel ratio: scale 2 draws a 1280px-wide app at 2560px. */
export interface Device {
  width: number;
  height: number;
  scale: number;
}

/** UI that shows once per user, marked seen in the persisted UI store before the first page. */
export interface Suppress {
  /** `publicAlertsSeen` ids, such as the dev banner. */
  alerts?: string[];
  /** `hintsSeen` ids, such as a first-visit menu hint. */
  hints?: string[];
}

/** WebP is written lossless by the system `cwebp` encoder, JPEG by the browser at quality 92. */
export type Format = 'webp' | 'png' | 'jpg';

/** One screenshot, written in both color modes as `<out>.<format>` and `<out>-dark.<format>`, or in its `mode` alone. */
export interface Shot {
  id: string;
  /** A key of `devices`. */
  device: string;
  /** Route on the frontend; a `{name}` placeholder takes the value its resolver returns. */
  path: string;
  /** From the app's root, without the extension. */
  out: string;
  /** Brings the page into the state the shot wants, after the route has rendered and settled. */
  open?: Opener;
  /** One color mode, written as `<out>.<format>`: for a file the app serves in one mode, such as its link preview. */
  mode?: 'light' | 'dark';
  /** Default the list's `format`. */
  format?: Format;
}

/** `cella/screenshots.ts`: the template's shots, synced with the UI they show. */
export interface ScreenshotsBase {
  /** The file type of every shot without a `format` of its own. */
  format: Format;
  devices: Record<string, Device>;
  suppress?: Suppress;
  /** Brings the shot user into the state the pages expect, before the first shot. */
  prepare?: Prepare;
  placeholders?: Placeholders;
  shots: Shot[];
}

/** `cella/screenshots.app.ts`, optional: what an app adds to the base, removes from it or overrides. */
export interface ScreenshotsApp {
  format?: ScreenshotsBase['format'];
  /** Join the base's; a name in both takes this one. */
  devices?: Record<string, Device>;
  /** Joins the base's lists. */
  suppress?: Suppress;
  /** Runs after the base's. */
  prepare?: Prepare;
  /** Joins the base's; a name in both takes this one. */
  placeholders?: Placeholders;
  /** Base shot ids the app does not ship. */
  remove?: string[];
  /** Shots of the app's own; one with a base shot's id replaces it in place. */
  add?: Shot[];
}

const formatSchema = z.enum(['webp', 'png', 'jpg']);

const deviceSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale: z.number().positive(),
});

const suppressSchema = z.strictObject({
  alerts: z.array(z.string()).optional(),
  hints: z.array(z.string()).optional(),
});

const shotSchema = z.strictObject({
  id: z.string().min(1),
  device: z.string().min(1),
  path: z.string().startsWith('/').or(z.string().startsWith('{')),
  out: z.string().min(1),
  open: fn<Opener>().optional(),
  mode: z.enum(['light', 'dark']).optional(),
  format: formatSchema.optional(),
}) satisfies z.ZodType<Shot>;

export const baseSchema = z.strictObject({
  format: formatSchema,
  devices: z.record(z.string(), deviceSchema),
  suppress: suppressSchema.optional(),
  prepare: fn<Prepare>().optional(),
  placeholders: placeholdersSchema.optional(),
  shots: z.array(shotSchema).min(1),
}) satisfies z.ZodType<ScreenshotsBase>;

export const appSchema = z.strictObject({
  format: formatSchema.optional(),
  devices: z.record(z.string(), deviceSchema).optional(),
  suppress: suppressSchema.optional(),
  prepare: fn<Prepare>().optional(),
  placeholders: placeholdersSchema.optional(),
  remove: z.array(z.string()).optional(),
  add: z.array(shotSchema).optional(),
}) satisfies z.ZodType<ScreenshotsApp>;

export const defineScreenshotsBase = (base: ScreenshotsBase): ScreenshotsBase => base;

export const defineScreenshotsApp = (app: ScreenshotsApp): ScreenshotsApp => app;
