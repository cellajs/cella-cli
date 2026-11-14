import { z } from 'zod';
import { type Opener, openerSchema, pathSchema, type SignInFields, signInShape } from '../utils/app-adapter';

/** A viewport and its pixel ratio: scale 2 draws a 1280px-wide app at 2560px. */
export interface Device {
  width: number;
  height: number;
  scale: number;
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

/** `cella/screenshots.ts`: the template's shots, kept in step with the UI they show. */
export interface ScreenshotsBase extends SignInFields {
  /** The file type of every shot without a `format` of its own. */
  format: Format;
  devices: Record<string, Device>;
  shots: Shot[];
}

/** `cella/screenshots.app.ts`, optional: what an app adds to the base, removes from it or overrides. */
export interface ScreenshotsApp extends SignInFields {
  format?: Format;
  /** Join the base's; a name in both takes this one. */
  devices?: Record<string, Device>;
  /** Base shot ids the app does not ship. */
  remove?: string[];
  /** Shots of the app's own; one with a base shot's id replaces it in place. */
  add?: Shot[];
}

const formatSchema = z.enum(['webp', 'png', 'jpg']);

const devicesSchema = z.record(
  z.string(),
  z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scale: z.number().positive(),
  }),
);

const shotSchema = z.strictObject({
  id: z.string().min(1),
  device: z.string().min(1),
  path: pathSchema,
  out: z.string().min(1),
  open: openerSchema.optional(),
  mode: z.enum(['light', 'dark']).optional(),
  format: formatSchema.optional(),
}) satisfies z.ZodType<Shot>;

export const baseSchema = z.strictObject({
  ...signInShape,
  format: formatSchema,
  devices: devicesSchema,
  shots: z.array(shotSchema).min(1),
}) satisfies z.ZodType<ScreenshotsBase>;

export const appSchema = z.strictObject({
  ...signInShape,
  format: formatSchema.optional(),
  devices: devicesSchema.optional(),
  remove: z.array(z.string()).optional(),
  add: z.array(shotSchema).optional(),
}) satisfies z.ZodType<ScreenshotsApp>;

export const defineScreenshotsBase = (base: ScreenshotsBase): ScreenshotsBase => base;

export const defineScreenshotsApp = (app: ScreenshotsApp): ScreenshotsApp => app;
