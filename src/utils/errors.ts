/**
 * Error helpers for sync CLI.
 */

/** The message of an unknown thrown value: an Error's message, anything else via String(). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
