import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { TestbedHandle } from '../testbed';
import {
  applyDelta,
  fillPath,
  loadAdapter,
  mergeSignIn,
  type SignedInRun,
  type SignInSetup,
  signIn,
} from '../utils/app-adapter';
import { newContext, openPage } from '../utils/browser';
import pc from '../utils/colors';
import { printStep, warningMark } from '../utils/display';
import { settle } from '../utils/drive';
import { appSchema, baseSchema, type Device, type Format, type Shot } from './adapter';

/** The shot list with the app's delta applied. */
interface ShotList extends SignInSetup {
  format: Format;
  devices: Record<string, Device>;
  shots: Shot[];
}

export interface ShootOptions {
  /** Shot ids; all when empty. */
  ids: string[];
  /** A folder for a trial run; default the files the app ships. */
  out?: string;
  /** The shot user; default the testbed's `ADMIN_EMAIL`. */
  email?: string;
}

// The nav bar's first button shows the logo for three seconds after mount (`AppNavLoader`): every shot waits it out, so a pair never differs by it
const introMs = 3200;
// The first signed-in page compiles most of the app on demand when the frontend is a dev server
const pageMs = 120_000;
// A 1200x630 link preview weighs about 90 KB at 92, a quarter of its PNG
const jpegQuality = 92;
// A shot whose `out` lies here is a file the frontend serves, at the path that follows
const publicDir = 'frontend/public/';

export async function loadShotList(repoRoot: string): Promise<ShotList> {
  const { base, app } = await loadAdapter(repoRoot, 'screenshots', baseSchema, appSchema);
  const shots = applyDelta(base.shots, app, 'cella/screenshots.app.ts');
  const devices = { ...base.devices, ...app?.devices };
  for (const shot of shots) {
    if (!devices[shot.device]) {
      throw new Error(`shot ${shot.id} takes device "${shot.device}", which neither adapter defines`);
    }
  }
  return { ...mergeSignIn(base, app), format: app?.format ?? base.format, devices, shots };
}

/** Asked before the testbed starts: a missing encoder is known in a second, not after the last shot. */
export function requireEncoder(list: ShotList): void {
  const webp = list.shots.some((shot) => (shot.format ?? list.format) === 'webp');
  if (webp && spawnSync('cwebp', ['-version']).status !== 0) {
    throw new Error(
      "format 'webp' needs the cwebp encoder on the PATH: `brew install webp` or `apt install webp`, or set format to 'png'",
    );
  }
}

/**
 * Resolves once no spinner has shown for `quiet` ms, or after `cap` ms. `settle` sees only the DOM, and a slow API can
 * leave that unchanged for longer than its quiet time, so a page whose rows and counts are still on their way passes it.
 */
async function spinnersGone(page: Page, quiet = 1000, cap = 45_000): Promise<void> {
  const deadline = Date.now() + cap;
  let since = Date.now();
  while (Date.now() < deadline) {
    if (await page.locator('.animate-spin').count()) since = Date.now();
    else if (Date.now() - since >= quiet) return;
    await page.waitForTimeout(100);
  }
}

/**
 * Writes a screenshot the browser encoded as PNG or JPEG. WebP is lossless, so the pixels are the screenshot's own, at
 * the encoder's slowest and smallest setting: a third of the PNG for a page of flat color and text.
 */
function writeShot(image: Buffer, path: string, format: Format): void {
  if (format !== 'webp') {
    writeFileSync(path, image);
    return;
  }
  const folder = mkdtempSync(join(tmpdir(), 'cella-shot-'));
  const source = join(folder, 'shot.png');
  writeFileSync(source, image);
  const encoded = spawnSync('cwebp', ['-quiet', '-lossless', '-z', '9', source, '-o', path], { encoding: 'utf8' });
  rmSync(folder, { recursive: true, force: true });
  if (encoded.status !== 0) throw new Error(`cwebp could not write ${path}: ${encoded.stderr.trim()}`);
}

interface Written {
  id: string;
  mode: string;
  path: string;
  bytes: number;
  pixels: string;
}

/** What every shot of one run reads. */
interface ShotRun {
  repoRoot: string;
  run: SignedInRun;
  format: Format;
  out?: string;
  /** Files this run wrote that the frontend serves, by the path it serves them at. */
  fresh: Map<string, string>;
}

/** Opens one shot's route in `context`, brings it into the shot's state and writes the file. */
async function takeShot(
  context: BrowserContext,
  shot: Shot,
  { device, mode }: { device: Device; mode: 'light' | 'dark' },
  { repoRoot, run, format: listFormat, out, fresh }: ShotRun,
): Promise<Written> {
  const target = out ? join(resolve(out), basename(shot.out)) : join(repoRoot, shot.out);
  const format = shot.format ?? listFormat;
  const suffix = mode === 'dark' && !shot.mode ? '-dark' : '';
  const path = `${target}${suffix}.${format}`;
  const route = fillPath(shot.path, run.values, 'the screenshots adapter');
  const page = await openPage(context, `${run.user.frontendUrl}${route}`, { timeout: pageMs });
  try {
    await page.waitForTimeout(introMs);
    await spinnersGone(page);
    await shot.open?.(page);
    await settle(page, { cap: 5000 });
    // A click in `open` leaves the control focused and the pointer over it: neither belongs in a marketing shot. The
    // pointer parks in the top right corner, which is page header or background in every layout; the bottom corners are
    // a table row and the sidebar, and both take a hover style.
    await page.mouse.move(device.width - 1, 0);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await settle(page, { quiet: 200, cap: 1000 });
    await spinnersGone(page, 1500);

    mkdirSync(dirname(path), { recursive: true });
    const encoding = format === 'jpg' ? { type: 'jpeg' as const, quality: jpegQuality } : { type: 'png' as const };
    const image = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'device', ...encoding });
    writeShot(image, path, format);
  } finally {
    await page.close();
  }
  if (shot.out.startsWith(publicDir)) fresh.set(`/${shot.out.slice(publicDir.length)}${suffix}.${format}`, path);
  const pixels = `${device.width * device.scale}x${device.height * device.scale}`;
  return { id: shot.id, mode, path, bytes: statSync(path).size, pixels };
}

/**
 * Shoots the list on a testbed, a light and a dark shot each unless a shot names one mode, and prints every file with
 * its pixel and file size.
 * Resolves to the exit code: 1 when a shot failed.
 */
export async function shoot(repoRoot: string, list: ShotList, testbed: TestbedHandle, options: ShootOptions) {
  const run = await signIn(repoRoot, list, { email: options.email, env: testbed.env });
  // The testbed serves the frontend it built at its start, so a shot that shows another shot's file gets this run's copy
  const take: ShotRun = { repoRoot, run, format: list.format, out: options.out, fresh: new Map() };
  const origin = new URL(run.user.frontendUrl).origin;
  const written: Written[] = [];
  const failures: { id: string; mode: string; error: string }[] = [];

  try {
    // One context per device and mode: the UI store lives in the context, so it is written once and every shot in the
    // group inherits it. A pair is the same recipe run twice, which is what keeps the light and dark shot in register.
    for (const deviceName of new Set(list.shots.map((shot) => shot.device))) {
      const device = list.devices[deviceName];
      for (const mode of ['light', 'dark'] as const) {
        const shots = list.shots.filter((shot) => shot.device === deviceName && (!shot.mode || shot.mode === mode));
        if (shots.length === 0) continue;
        const context = await newContext(run.browser, {
          viewport: { width: device.width, height: device.height },
          deviceScaleFactor: device.scale,
          colorScheme: mode,
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
          locale: 'en-US',
          timezoneId: 'Europe/Amsterdam',
          session: run.user,
          uiStore: { slug: run.user.slug, state: { mode, ...list.seen } },
        });
        await context.route(
          (url) => url.origin === origin && take.fresh.has(url.pathname),
          (route) => route.fulfill({ path: take.fresh.get(new URL(route.request().url()).pathname) }),
        );
        for (const shot of shots) {
          try {
            written.push(await takeShot(context, shot, { device, mode }, take));
          } catch (error) {
            const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
            failures.push({ id: shot.id, mode, error: message });
          }
        }
        await context.close();
      }
    }
  } finally {
    await run.close();
  }

  console.info();
  for (const image of written) {
    const size = `${String(Math.round(image.bytes / 1024)).padStart(5)} KB`;
    console.info(
      `  ${image.id.padEnd(20)} ${image.mode.padEnd(5)} ${image.pixels.padEnd(10)} ${size}  ${pc.dim(image.path)}`,
    );
  }
  for (const failure of failures) console.info(`  ${warningMark} ${failure.id} ${failure.mode}: ${failure.error}`);
  console.info();
  const expected = list.shots.reduce((sum, shot) => sum + (shot.mode ? 1 : 2), 0);
  printStep('written', `${written.length} of ${expected}; look at every one against the screenshots skill's rubric`);
  return failures.length > 0 ? 1 : 0;
}
