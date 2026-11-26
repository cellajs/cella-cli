import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';

/** Columns a line may use: the terminal's width, 80 when stdout is not a terminal. */
export function terminalColumns(): number {
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  return Math.max(60, columns || 80);
}

/** The frames of every spinner the CLI draws, one per redraw. */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Width of `text` as a terminal shows it: colors and OSC 8 link targets take no columns. */
export function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length;
}

/** Pad `text` with spaces to `width` visible columns, on the right (`start`) or left (`end`). */
export function padVisible(text: string, width: number, align: 'start' | 'end' = 'start'): string {
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  return align === 'start' ? `${text}${padding}` : `${padding}${text}`;
}

/** Plain `text` cut to `width` columns, ending in `…` when cut: at a word where one ends in the second half of the room. */
export function fitText(text: string, width: number): string {
  if (text.length <= width) return text;
  const cut = text.slice(0, Math.max(0, width - 1));
  const word = cut.lastIndexOf(' ');
  return `${(word > width / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** Steps git's relative dates use (`--date=relative`), in seconds, with the unit each prints in. */
const ageSteps: Array<[below: number, unit: number, suffix: string]> = [
  [90 * 60, 60, 'm'],
  [36 * 3600, 3600, 'h'],
  [14 * 86400, 86400, 'd'],
  [70 * 86400, 7 * 86400, 'w'],
  [365 * 86400, 30 * 86400, 'mo'],
];

/** `4m`, `3h`, `2d`, `8w`, `3mo`, `2y` since `epochSeconds`; `now` under a minute. */
export function shortAge(epochSeconds: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.round(nowMs / 1000 - epochSeconds));
  if (seconds < 60) return 'now';
  for (const [below, unit, suffix] of ageSteps) {
    if (seconds < below) return `${Math.max(1, Math.round(seconds / unit))}${suffix}`;
  }
  return `${Math.floor(seconds / (365 * 86400))}y`;
}

/** A line count that fits a narrow column: `909`, `9999`, `12.4k`, `311.8k`, `1.2M`. */
export function compactCount(count: number): string {
  if (count < 10_000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
