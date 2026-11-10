/**
 * Error helpers for sync CLI.
 */

/**
 * The message of an unknown thrown value: an Error's message and its cause's, anything else via String(). The cause
 * carries what `fetch failed` leaves out, such as the refused address.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}
