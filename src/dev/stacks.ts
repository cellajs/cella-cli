import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime, userInfo } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import { isAlive, isGroupAlive } from '../utils/process-group';

/**
 * One file per running dev stack of any app on this machine. The home directory comes from the account, never `HOME`:
 * an agent that runs with a scratch home sees the developer's stacks too.
 */
const stacksDir = join(userInfo().homedir, '.config', 'cellajs-cli', 'dev-stacks');

/** Boot times this far apart belong to two boots. */
const bootToleranceMs = 60_000;

const stackSchema = z.object({
  /** The process group of the command it runs, which leads that group. */
  group: z.number().int().positive(),
  /** The `cella dev` process that started it. */
  launcher: z.number().int().positive(),
  /** As `ps -o lstart` prints it in UTC: a group id a later process took shows another start. */
  leaderStart: z.string(),
  /** The machine's boot, in epoch milliseconds: a group id from an earlier boot names nothing of this stack. */
  bootedAt: z.number(),
  checkout: z.string(),
  app: z.string(),
  offset: z.number().int().nonnegative(),
  url: z.string(),
  /** Every port its services listen on. */
  ports: z.array(z.number().int()),
  log: z.string(),
  command: z.array(z.string()),
  /** Epoch milliseconds. */
  startedAt: z.number(),
});

export type Stack = z.infer<typeof stackSchema>;

const bootedAt = () => Date.now() - uptime() * 1000;
const recordPath = (group: number) => join(stacksDir, `${group}.json`);

/** The parent and the start of `pid`; undefined once it exited. */
function processFacts(pid: number): { parent: number; start: string } | undefined {
  const { stdout } = spawnSync('ps', ['-o', 'ppid=,lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
  return match ? { parent: Number(match[1]), start: match[2] } : undefined;
}

/** The start `recordStack` stores for the group `leader` leads. */
export const leaderStart = (leader: number): string | undefined => processFacts(leader)?.start;

export function recordStack(stack: Omit<Stack, 'bootedAt'>): void {
  mkdirSync(stacksDir, { recursive: true, mode: 0o700 });
  const temp = `${recordPath(stack.group)}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...stack, bootedAt: bootedAt() } satisfies Stack, null, 2), { mode: 0o600 });
  renameSync(temp, recordPath(stack.group));
}

export const forgetStack = (group: number): void => rmSync(recordPath(group), { force: true });

/** Whether any process of the stack's group runs, the group a later process took aside. */
function runs(stack: Stack): boolean {
  if (Math.abs(stack.bootedAt - bootedAt()) > bootToleranceMs || !isGroupAlive(stack.group)) return false;
  // With its leader gone the group lives on only in processes of this stack: an id stays taken while a group holds it
  const leader = processFacts(stack.group);
  return !leader || leader.start === stack.leaderStart;
}

/** Whether the `cella dev` that started the stack still holds it; false for a stack whose launcher was killed. */
export function launcherHolds(stack: Stack): boolean {
  return isAlive(stack.launcher) && processFacts(stack.group)?.parent === stack.launcher;
}

/** The stacks that run, the oldest first. A record of a stack that ended is removed on the way. */
export function liveStacks(): Stack[] {
  let files: string[];
  try {
    files = readdirSync(stacksDir).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  const stacks: Stack[] = [];
  for (const file of files) {
    const path = join(stacksDir, file);
    let parsed: ReturnType<typeof stackSchema.safeParse>;
    try {
      parsed = stackSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      continue;
    }
    // A record another CLI version wrote is left to that version
    if (!parsed.success) continue;
    if (runs(parsed.data)) stacks.push(parsed.data);
    else rmSync(path, { force: true });
  }
  return stacks.sort((a, b) => a.startedAt - b.startedAt);
}

/** The processes of each process group on the machine and their resident memory in bytes, from one `ps`. */
export function groupUsage(): Map<number, { processes: number; memory: number }> {
  const { stdout } = spawnSync('ps', ['-A', '-o', 'pgid=,rss='], { encoding: 'utf8' });
  const usage = new Map<number, { processes: number; memory: number }>();
  for (const line of stdout.split('\n')) {
    const [group, kilobytes] = line.trim().split(/\s+/).map(Number);
    if (!group) continue;
    const entry = usage.get(group) ?? { processes: 0, memory: 0 };
    entry.processes += 1;
    entry.memory += (kilobytes || 0) * 1024;
    usage.set(group, entry);
  }
  return usage;
}

const sizeUnits: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** The machine's swap in use and its size in bytes; undefined on a system that reports neither. */
export function swapUsage(): { used: number; total: number } | undefined {
  if (process.platform === 'darwin') {
    // "total = 2048.00M  used = 1180.50M  free = 867.50M  (encrypted)"
    const { stdout } = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
    const size = (name: string) => {
      const match = new RegExp(`${name} = ([\\d.]+)([KMG])`).exec(stdout);
      return match ? Number(match[1]) * sizeUnits[match[2]] : undefined;
    };
    const [used, total] = [size('used'), size('total')];
    return used === undefined || total === undefined ? undefined : { used, total };
  }
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const kilobytes = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1]);
    const [total, free] = [kilobytes('SwapTotal'), kilobytes('SwapFree')];
    return Number.isNaN(total) || Number.isNaN(free) ? undefined : { used: (total - free) * 1024, total: total * 1024 };
  } catch {
    return undefined;
  }
}
