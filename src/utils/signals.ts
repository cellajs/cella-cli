import process from 'node:process';

type Cleanup = () => void | Promise<void>;

const cleanups = new Set<Cleanup>();

/** Run `cleanup` when ctrl-c or a kill ends the CLI; the returned function takes it back once its work is done. */
export function onShutdown(cleanup: Cleanup): () => void {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

const installed: [NodeJS.Signals, () => void][] = [];

/**
 * SIGINT exits 130 and SIGTERM 143, as a shell reports a process the signal ended, after the registered cleanups ran,
 * newest first. A second signal during cleanup ends the CLI at once.
 */
export function installSignalHandlers(): void {
  const handle = (code: number) => async () => {
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup();
      } catch {
        // The exit goes ahead: a cleanup that failed has nothing left to protect
      }
    }
    process.exit(code);
  };
  installed.push(['SIGINT', handle(130)], ['SIGTERM', handle(143)]);
  for (const [signal, handler] of installed) process.once(signal, handler);
}

/** Leaves ctrl-c and a kill to code the CLI runs in its own process, which ends its work and the process itself. */
export function handOverSignals(): void {
  for (const [signal, handler] of installed.splice(0)) process.off(signal, handler);
}
