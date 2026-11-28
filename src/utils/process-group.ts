import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

/** Whether `pid` runs, a process of another user included; a negative `pid` asks for any process of that group. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const isGroupAlive = (group: number): boolean => isAlive(-group);

export function killGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // It already exited
  }
}

/** Waits until no process of `group` runs; resolves false when one still runs after `timeoutMs`. */
export async function untilGroupGone(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isGroupAlive(group)) {
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
  return true;
}

/** Ends every process of `group`: SIGTERM, then SIGKILL for what still runs after `graceMs`. */
export async function endGroup(group: number, graceMs: number): Promise<void> {
  killGroup(group, 'SIGTERM');
  if (!(await untilGroupGone(group, graceMs))) killGroup(group, 'SIGKILL');
}
