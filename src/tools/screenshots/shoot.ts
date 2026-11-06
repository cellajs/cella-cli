import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import pc from '../../utils/colors';
import { printStep, warningMark } from '../../utils/display';
import { setEnv } from '../../utils/env';
import { onShutdown } from '../../utils/signals';
import { applyDelta, fillPath, loadAdapter, type Placeholders, type Prepare, signedIn } from '../adapters';
import { type Browser, loadPlaywright, mintSession, newContext, openPage, type Page, settle, signOut } from '../drive';
import type { TestbedHandle } from '../testbed';
import { appSchema, baseSchema, type Device, type ScreenshotsBase, type Shot } from './define';

/** The shot list with the app's delta applied. */
export interface ShotList {
  format: ScreenshotsBase['format'];
  devices: Record<string, Device>;
  suppress: { alerts: string[]; hints: string[] };
  prepare: Prepare[];
  placeholders: Placeholders;
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
const INTRO_MS = 3200;
// The first signed-in page compiles most of the app on demand when the frontend is a dev server
const PAGE_MS = 120_000;

export async function loadShotList(forkPath: string): Promise<ShotList> {
  // The adapters read the app config, which takes the development ports and URLs in development mode only
  setEnv('NODE_ENV', 'development');
  const { base, app } = await loadAdapter(forkPath, 'screenshots', baseSchema, appSchema);
  const shots = app ? applyDelta(base.shots, app, 'cella/screenshots.app.ts') : base.shots;
  const devices = { ...base.devices, ...app?.devices };
  for (const shot of shots) {
    if (!devices[shot.device]) {
      throw new Error(`shot ${shot.id} takes device "${shot.device}", which neither adapter defines`);
    }
  }
  const both = (key: 'alerts' | 'hints') => [...(base.suppress?.[key] ?? []), ...(app?.suppress?.[key] ?? [])];
  return {
    format: app?.format ?? base.format,
    devices,
    suppress: { alerts: both('alerts'), hints: both('hints') },
    prepare: [base.prepare, app?.prepare].filter((step) => step !== undefined),
    placeholders: { ...base.placeholders, ...app?.placeholders },
    shots,
  };
}

/** Asked before the testbed starts: a missing encoder is known in a second, not after the last shot. */
export function requireEncoder(format: ShotList['format']): void {
  if (format === 'webp' && spawnSync('cwebp', ['-version']).status !== 0) {
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

interface Written {
  id: string;
  mode: string;
  path: string;
  bytes: number;
  pixels: string;
}

/**
 * Shoots the list on a testbed, a light and a dark shot each, and prints every file with its pixel and file size.
 * Resolves to the exit code: 1 when a shot failed.
 */
export async function shoot(forkPath: string, list: ShotList, testbed: TestbedHandle, options: ShootOptions) {
  const email = options.email ?? testbed.env.ADMIN_EMAIL;
  if (!email) throw new Error('no shot user: pass --email, or set ADMIN_EMAIL in backend/.env');
  const todo = options.ids.length > 0 ? list.shots.filter((shot) => options.ids.includes(shot.id)) : list.shots;

  const user = mintSession(email, { forkPath, env: testbed.env });
  const scratch = mkdtempSync(join(tmpdir(), 'cella-screenshots-'));
  let browser: Browser | undefined;
  const cleanup = async () => {
    await browser?.close();
    await signOut(user);
    rmSync(scratch, { recursive: true, force: true });
  };
  const forget = onShutdown(cleanup);
  const written: Written[] = [];
  const failures: { id: string; mode: string; error: string }[] = [];

  /**
   * Writes a screenshot in the list's format. WebP is lossless, so the pixels are the screenshot's own, at the encoder's
   * slowest and smallest setting: a third of the PNG for a page of flat color and text.
   */
  const writeShot = (png: Buffer, path: string) => {
    if (list.format === 'png') {
      writeFileSync(path, png);
      return;
    }
    const source = join(scratch, 'shot.png');
    writeFileSync(source, png);
    const encoded = spawnSync('cwebp', ['-quiet', '-lossless', '-z', '9', source, '-o', path], { encoding: 'utf8' });
    if (encoded.status !== 0) throw new Error(`cwebp could not write ${path}: ${encoded.stderr.trim()}`);
  };

  try {
    // MFA on for the shot user and a share of their members, so the account page and member tables show both states.
    // Nobody can sign in with the factors it adds, which is why it runs on a testbed only.
    const showcase = spawnSync('pnpm', ['--silent', '--filter', 'backend', 'showcase:mfa', email], {
      cwd: forkPath,
      env: testbed.env,
      encoding: 'utf8',
    });
    if (showcase.status !== 0) throw new Error(`showcase:mfa failed:\n${showcase.stdout}\n${showcase.stderr}`);
    printStep('mfa', showcase.stdout.trim().split('\n').at(-1));

    for (const prepare of list.prepare) await prepare(signedIn(user));
    const values: Record<string, string | null> = {};
    for (const [name, resolve] of Object.entries(list.placeholders)) values[name] = await resolve(signedIn(user));

    const { chromium } = await loadPlaywright(forkPath);
    browser = await chromium.launch();

    // One context per device and mode: the UI store lives in the context, so it is written once and every shot in the
    // group inherits it. A pair is the same recipe run twice, which is what keeps the light and dark shot in register.
    for (const deviceName of [...new Set(todo.map((shot) => shot.device))]) {
      const device = list.devices[deviceName];
      for (const mode of ['light', 'dark'] as const) {
        const context = await newContext(browser, {
          viewport: { width: device.width, height: device.height },
          deviceScaleFactor: device.scale,
          colorScheme: mode,
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
          locale: 'en-US',
          timezoneId: 'Europe/Amsterdam',
          session: user,
          uiStore: {
            slug: user.slug,
            state: { mode, publicAlertsSeen: list.suppress.alerts, hintsSeen: list.suppress.hints },
          },
        });

        for (const shot of todo.filter((entry) => entry.device === deviceName)) {
          const target = options.out ? join(resolve(options.out), basename(shot.out)) : join(forkPath, shot.out);
          const path = `${target}${mode === 'dark' ? '-dark' : ''}.${list.format}`;
          let page: Page | undefined;
          try {
            const route = fillPath(shot.path, values, 'the screenshots adapter');
            page = await openPage(context, `${user.frontendUrl}${route}`, { timeout: PAGE_MS });
            await page.waitForTimeout(INTRO_MS);
            await spinnersGone(page);
            await shot.open?.(page);
            await settle(page, { cap: 5000 });
            // A click in `open` leaves the control focused and the pointer over it: neither belongs in a marketing
            // shot. The pointer parks in the top right corner, which is page header or background in every layout;
            // the bottom corners are a table row and the sidebar, and both take a hover style.
            await page.mouse.move(device.width - 1, 0);
            await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
            await settle(page, { quiet: 200, cap: 1000 });
            await spinnersGone(page, 1500);

            mkdirSync(dirname(path), { recursive: true });
            writeShot(await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'device' }), path);
            const pixels = `${device.width * device.scale}x${device.height * device.scale}`;
            written.push({ id: shot.id, mode, path, bytes: statSync(path).size, pixels });
          } catch (error) {
            failures.push({
              id: shot.id,
              mode,
              error: error instanceof Error ? error.message.split('\n')[0] : String(error),
            });
          } finally {
            await page?.close();
          }
        }
        await context.close();
      }
    }
  } finally {
    await cleanup();
    forget();
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
  printStep(
    'written',
    `${written.length} of ${todo.length * 2}; look at every one against the screenshots skill's rubric`,
  );
  return failures.length > 0 ? 1 : 0;
}
