import process from 'node:process';
import packageJson from '../../package.json' with { type: 'json' };
import pc from './colors';
import { getEnv } from './env';

/** Version from package.json */
export const version = packageJson.version;

/** Line divider */
export const divider = '─'.repeat(60);

/** Divider used above the exit entry of interactive menus */
export const menuDivider = '─'.repeat(40);

/** Width of the label column of step lines (`✓ upstream   …`) */
const stepLabelWidth = 9;

/** Where the detail of a step line starts: the mark, the label column and two spaces */
export const stepIndent = 2 + stepLabelWidth + 2;

/** Warning mark for non-fatal warnings */
export const warningMark = pc.yellow('⚠');

/** Check mark for successful status lines */
export const checkMark = pc.green('✓');

/** A progress line: `text` is read on every frame, `stop()` clears the line. */
type Spinner = { text: string; stop(): void };

/** Active spinner reference */
let activeSpinner: Spinner | null = null;

/**
 * When true, stdout is reserved for machine-readable payloads (e.g. `--json`),
 * so all human-facing output (header, warnings, steps, spinner) is routed to stderr.
 */
let jsonMode = false;

/**
 * Enable JSON mode: keep stdout clean for the JSON payload by sending every
 * human-facing line (console.info/console.warn, header, spinner) to stderr.
 * This makes `cella --json ... | jq` pipe cleanly.
 */
export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
  if (!enabled) return;
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`);
  };
  console.info = toStderr;
  console.warn = toStderr;
}

/** Write a machine-readable payload to stdout (bypasses the stderr routing of JSON mode). */
export function writeStdout(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function printHeader(): void {
  const left = '⧈ cella cli';
  const versionLabel = ` · v${version}`;
  const right = 'cellajs.com';
  // Padding counts the visible characters only, not the ANSI codes
  const padding = Math.max(1, divider.length - `${left}${versionLabel}${right}`.length);
  console.info();
  console.info(`${pc.cyan(left)}${pc.dim(versionLabel)}${pc.cyan(`${' '.repeat(padding)}${right}`)}`);
  console.info(divider);
  console.info();
}

/** Start a progress spinner; suppressed in test environments and JSON mode. */
export function createSpinner(text: string): Spinner {
  // One line holds one spinner: a new one replaces the one still running
  stopSpinner();
  const enabled = !jsonMode && !getEnv('VITEST') && getEnv('NODE_ENV') !== 'test' && !!process.stdout.isTTY;
  const frames = ['-', '\\', '|', '/'];
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const spinner: Spinner = {
    text,
    stop() {
      clearInterval(timer);
      if (enabled) process.stdout.write('\r\x1b[2K');
    },
  };
  const render = () => process.stdout.write(`\r${pc.cyan(frames[frame++ % frames.length])} ${spinner.text}`);
  if (enabled) {
    render();
    // A spinner a thrown error leaves running must not hold the process open
    timer = setInterval(render, 80).unref();
  }
  activeSpinner = spinner;
  return spinner;
}

/**
 * Print a completed step on one line, `✓ label  detail`; further lines of
 * `detail` line up under its first.
 */
export function printStep(label: string, detail?: string, mark = checkMark): void {
  stopSpinner();
  const [first = '', ...rest] = (detail ?? '').split('\n');
  console.info(`${mark} ${pc.bold(label.padEnd(stepLabelWidth))}  ${first}`.trimEnd());
  for (const line of rest) console.info(line ? `${' '.repeat(stepIndent)}${line}` : '');
}

/** Print a completed step of a run that goes on: the step, then a fresh spinner for what follows. */
export function printProgressStep(label: string, detail?: string): void {
  printStep(label, detail);
  createSpinner('...');
}

/** Stop the spinner and print `message` as a completed step; `detail` adds a dim line and a blank line. */
export function spinnerSuccess(message?: string, detail?: string): void {
  stopSpinner();
  if (!message) return;
  console.info(`${checkMark} ${message}`);
  if (detail) {
    console.info(`  ${pc.dim(detail)}`);
    console.info();
  }
}

export function spinnerFail(message: string): void {
  stopSpinner();
  console.info(`${pc.red('✗')} ${message}`);
}

export function spinnerText(text: string): void {
  if (activeSpinner) {
    activeSpinner.text = text;
  }
}

function stopSpinner(): void {
  if (activeSpinner) {
    activeSpinner.stop();
    activeSpinner = null;
  }
}

/**
 * Create a clickable hyperlink for terminals that support OSC 8.
 * Falls back to just the label if no URL provided.
 */
export function hyperlink(label: string, url?: string): string {
  if (!url) return label;
  // Strip control characters from URL to prevent terminal escape injection (CWE-116)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the security purpose here.
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, '');
  // OSC 8 hyperlink format: \x1b]8;;URL\x07LABEL\x1b]8;;\x07
  return `\x1b]8;;${safeUrl}\x07${label}\x1b]8;;\x07`;
}

/** One step of `next steps`: a label for what to do, the command or link, and lines under it. */
export interface NextStep {
  label: string;
  line: string;
  details?: string[];
}

/**
 * The `next steps` section that closes a command, numbered in the order to take them. The line and
 * details of each step start at the column step details do.
 */
export function printNextSteps(steps: NextStep[]): void {
  if (steps.length === 0) return;
  printSectionHeader(pc.cyan('next steps'));
  for (const [index, step] of steps.entries()) {
    const label = step.label.padEnd(stepIndent - 5);
    console.info(`  ${pc.dim(String(index + 1))} ${pc.bold(label)} ${step.line}`.trimEnd());
    for (const detail of step.details ?? []) console.info(`${' '.repeat(stepIndent)}${detail}`);
  }
}

/** A section header: a blank line, the title, the divider under it, and a blank line. */
export function printSectionHeader(title: string): void {
  console.info();
  console.info(title);
  console.info(divider);
  console.info();
}

/** `1 file`, `2 files`: a count with its noun. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
