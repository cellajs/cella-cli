import { variableName } from '../lib/description/schema';
import { composeConfig } from './compose';
import type { ComposeFile } from './types';

const generatedHeader = [
  '# Rendered from infra/description.yml by the deploy engine: `cella infra compose` prints it.',
  '# The deploy machinery and its rationale ship in @cellajs/cli (src/infra/compose/infrastructure.ts).',
].join('\n');

/** Keys whose array value is rendered as an inline flow sequence, not a block. */
const flowKeys = new Set(['profiles', 'test']);
/** Flow-sequence keys whose elements are always single-quoted (e.g. `test`). */
const flowQuotedKeys = new Set(['test']);

/** YAML plain scalars that must be quoted to avoid type coercion or parse errors. */
function needsQuote(v: string): boolean {
  if (v === '') return true;
  if (/^\s|\s$/.test(v)) return true; // leading/trailing whitespace
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return true; // YAML indicator start
  if (/:\s|\s#|:$/.test(v)) return true; // "key: value", " #comment" or a trailing ":" ambiguity
  if (/^[+-]?\d/.test(v)) return true; // numbers, ports, durations, IPs
  if (/^[+-]?\.(?:\d|inf$|nan$)/i.test(v)) return true; // floats such as .5, +.5, .inf and .nan
  if (/^(y|yes|n|no|true|false|on|off|null|~)$/i.test(v)) return true; // bool/null coercion
  if (v === '<<') return true; // a merge key
  return false;
}

/** A Compose placeholder as the engine writes one: `${NAME}` or `${NAME:-fallback}`. */
const placeholder = new RegExp(String.raw`\$\{${variableName}(?::-[^$}]*)?\}`, 'g');

/** The keys under which the engine writes placeholders into a value: an image reference, and the agent's command and mounts. */
const placeholderKeys = new Set(['image', 'command', 'volumes']);

/** Where a value sits: its key, and the key of the mapping that holds it. */
interface Place {
  key: string;
  parent: string | undefined;
}

/**
 * Whether the engine wrote each `$` of a value: as placeholders under an image, command or mounts key, or as the one placeholder of an
 * `environment` value that names its own variable, which the static env fills.
 */
function engineDollars(v: string, { key, parent }: Place): boolean {
  if (parent === 'environment') return v.match(new RegExp(String.raw`^\$\{(${variableName})(?::-[^$}]*)?\}$`))?.[1] === key;
  return placeholderKeys.has(key) && !v.replace(placeholder, '').includes('$');
}

/**
 * A scalar on one line, a mapping key or a value, quoted where YAML would read it as another type or another key.
 * @param place where a value sits; a key takes none, and holds no `$`
 * @throws on a control character, which a quoted line folds or ends, and on a `$` the engine did not write, which Compose would interpolate
 */
function scalar(v: string, forceQuote = false, place?: Place): string {
  if (/\p{Cc}/u.test(v)) throw new Error(`compose synth: refused ${JSON.stringify(v)}, which holds a control character`);
  if (v.includes('$') && !(place && engineDollars(v, place))) {
    throw new Error(`compose synth: refused ${JSON.stringify(v)}, which holds a $ the engine did not write: Compose would interpolate it`);
  }
  if (forceQuote || needsQuote(v)) return `'${v.replace(/'/g, "''")}'`;
  return v;
}

function emitMapping(obj: object, indent: number, parent?: string): string[] {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  for (const [name, val] of Object.entries(obj) as Array<[string, unknown]>) {
    const key = scalar(name);
    const place = { key: name, parent };
    if (val === null || val === undefined) {
      lines.push(`${pad}${key}:`);
    } else if (Array.isArray(val)) {
      if (flowKeys.has(name)) {
        const quoted = flowQuotedKeys.has(name);
        lines.push(`${pad}${key}: [${val.map((x) => scalar(String(x), quoted, place)).join(', ')}]`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of val) {
          if (item === null || typeof item !== 'object') {
            lines.push(`${pad}  - ${scalar(String(item), false, place)}`);
            continue;
          }
          // A mapping item: its first key on the dash line, the rest under it.
          const [first = '', ...rest] = emitMapping(item, indent + 2, name);
          lines.push(`${pad}  - ${first.trimStart()}`, ...rest);
        }
      }
    } else if (typeof val === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(...emitMapping(val, indent + 1, name));
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`${pad}${key}: ${val}`);
    } else {
      lines.push(`${pad}${key}: ${scalar(String(val), false, place)}`);
    }
  }
  return lines;
}

/** Render a ComposeFile to deterministic YAML text. */
export function renderCompose(file: ComposeFile): string {
  const lines: string[] = ['services:'];
  for (const [name, svc] of Object.entries(file.services)) {
    lines.push(`  ${scalar(name)}:`);
    lines.push(...emitMapping(svc, 2));
  }
  return `${generatedHeader}\n\n${lines.join('\n')}\n`;
}

/** The task `compose`: prints the Compose file the deploy renders from the description, which each machine's user data carries. */
export function main(): void {
  process.stdout.write(renderCompose(composeConfig));
}
