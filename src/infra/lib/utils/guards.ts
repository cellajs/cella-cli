import { errorMessage } from './errors';

/** Narrow an unknown value to a plain (non-array) object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a stored record's JSON text, which the caller then checks field by field.
 * @throws `<what>: not valid JSON (<the parser's message>)`, followed by `; <remedy>` when one is given
 */
export function parseJson(text: string, what: string, remedy?: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what}: not valid JSON (${errorMessage(err)})${remedy ? `; ${remedy}` : ''}`);
  }
}
