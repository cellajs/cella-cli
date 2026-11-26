/**
 * Message of a caught value without assuming it is an `Error`; a thrown
 * string/object would make `(err as Error).message` yield `undefined` in
 * operator-facing output. An Error's cause follows its message after a colon.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

/**
 * A task failure that asks for a specific process exit code. Being thrown, it stops a caller that runs the task
 * in-process (the deploy); `runTask` (run.ts) exits with `exitCode`.
 */
export class ExitCodeError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'ExitCodeError';
    this.exitCode = exitCode;
  }
}
