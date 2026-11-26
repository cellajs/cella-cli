import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { infraDir } from '../lib/utils/paths';
import { composeConfig } from './compose';
import type { ComposeFile } from './types';

const GENERATED_HEADER = [
  '# DO NOT EDIT: generated from config/services.config.ts by `pnpm --filter infra compose:generate`.',
  '# Edit the service registry there and re-run the command.',
  '# The deploy machinery and its rationale ship in @cellajs/cli (src/infra/compose/infrastructure.ts).',
].join('\n');

/** A Compose file without its leading comment lines: a file whose header an older release wrote is still current. */
function withoutHeader(yaml: string): string {
  return yaml.replace(/^(?:#.*\n)*/, '');
}

/** Keys whose array value is rendered as an inline flow sequence, not a block. */
const FLOW_KEYS = new Set(['profiles', 'test']);
/** Flow-sequence keys whose elements are always single-quoted (e.g. `test`). */
const FLOW_QUOTED_KEYS = new Set(['test']);

/** YAML plain scalars that must be quoted to avoid type coercion or parse errors. */
function needsQuote(v: string): boolean {
  if (v === '') return true;
  if (/^\s|\s$/.test(v)) return true; // leading/trailing whitespace
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return true; // YAML indicator start
  if (/:\s|\s#/.test(v)) return true; // "key: value" or " #comment" ambiguity
  if (/^[+-]?\d/.test(v)) return true; // numbers, ports, durations, IPs
  if (/^(y|yes|n|no|true|false|on|off|null|~)$/i.test(v)) return true; // bool/null coercion
  return false;
}

/** A scalar on one line, quoted where YAML would read it as another type. @throws on a control character, which a quoted line folds or ends. */
function scalar(v: string, forceQuote = false): string {
  if (/\p{Cc}/u.test(v)) throw new Error(`compose synth: refused ${JSON.stringify(v)}, which holds a control character`);
  if (forceQuote || needsQuote(v)) return `'${v.replace(/'/g, "''")}'`;
  return v;
}

function emitMapping(obj: object, indent: number): string[] {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  for (const [key, val] of Object.entries(obj) as Array<[string, unknown]>) {
    if (val === null || val === undefined) {
      lines.push(`${pad}${key}:`);
    } else if (Array.isArray(val)) {
      if (FLOW_KEYS.has(key)) {
        const quoted = FLOW_QUOTED_KEYS.has(key);
        lines.push(`${pad}${key}: [${val.map((x) => scalar(String(x), quoted)).join(', ')}]`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of val) {
          if (item === null || typeof item !== 'object') {
            lines.push(`${pad}  - ${scalar(String(item))}`);
            continue;
          }
          // A mapping item: its first key on the dash line, the rest under it.
          const [first = '', ...rest] = emitMapping(item, indent + 2);
          lines.push(`${pad}  - ${first.trimStart()}`, ...rest);
        }
      }
    } else if (typeof val === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(...emitMapping(val, indent + 1));
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`${pad}${key}: ${val}`);
    } else {
      lines.push(`${pad}${key}: ${scalar(String(val))}`);
    }
  }
  return lines;
}

/** Render a ComposeFile to deterministic YAML text. Pure, exported for tests. */
export function renderCompose(file: ComposeFile): string {
  const lines: string[] = ['services:'];
  for (const [name, svc] of Object.entries(file.services)) {
    lines.push(`  ${name}:`);
    lines.push(...emitMapping(svc, 2));
  }
  return `${GENERATED_HEADER}\n\n${lines.join('\n')}\n`;
}

/** The generated deploy artifact, read by the deploy and written into each machine's user data. */
export const OUTPUT_PATH = join(infraDir, 'compose.gen.yml');

/** `compose-generate` writes the file; with `--check`, as `compose-check` runs it, it fails when the file differs. */
export function main(words: string[]): void {
  const yaml = renderCompose(composeConfig);
  if (words.includes('--check')) {
    const current = readCompose();
    if (current === undefined) {
      console.error(`::error::${OUTPUT_PATH} is missing: run \`pnpm --filter infra compose:generate\`.`);
      process.exit(1);
    }
    if (withoutHeader(current) !== withoutHeader(yaml)) {
      console.error(`::error::${OUTPUT_PATH} is out of date: run \`pnpm --filter infra compose:generate\` and commit.`);
      process.exit(1);
    }
    console.info('compose.gen.yml is up to date.');
    return;
  }
  writeCompose();
  console.info(`Wrote ${OUTPUT_PATH}`);
}

/** The Compose file on disk; undefined when it is missing. */
function readCompose(): string | undefined {
  try {
    return readFileSync(OUTPUT_PATH, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Write the Compose file from the service registry; `unchanged` when the file already holds it, so a caller can stay quiet. */
export function writeCompose(): 'written' | 'unchanged' {
  const yaml = renderCompose(composeConfig);
  const current = readCompose();
  if (current !== undefined && withoutHeader(current) === withoutHeader(yaml)) return 'unchanged';
  writeFileSync(OUTPUT_PATH, yaml);
  return 'written';
}
