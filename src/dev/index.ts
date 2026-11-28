import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { constants, totalmem, userInfo } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import type { Command } from '../command';
import { loadAppConfig, rootPackage, toolDir } from '../utils/app';
import pc from '../utils/colors';
import { printStep, spinnerFail } from '../utils/display';
import { endGroup, killGroup, untilGroupGone } from '../utils/process-group';
import { onShutdown } from '../utils/signals';
import { forgetStack, groupUsage, launcherHolds, leaderStart, liveStacks, recordStack, type Stack, swapUsage } from './stacks';

/** How long a stack's processes get to exit before they are killed. */
const stopGraceMs = 10_000;

/** The part of the app's development config a stack record reads. */
const appConfigSchema = z.object({
  frontendUrl: z.string(),
  devPortOffset: z.number(),
  services: z.record(z.string(), z.object({ enabled: z.boolean(), port: z.number(), internalPort: z.number().optional() })),
});

interface DevOptions {
  job: 'start' | 'status' | 'stop';
  /** status: every app's stacks on the machine, not only this checkout's. */
  all: boolean;
  /** stop: the process group `status --all` lists, of any checkout. */
  group?: number;
  /** start: the command that runs the stack, the words after `--`. */
  command: string[];
}

const size = (bytes: number) => (bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`);
const tilde = (path: string) => path.replace(userInfo().homedir, '~');

function age(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const describe = (stack: Stack) => `${stack.url} (${stack.app}, ${tilde(stack.checkout)}, process group ${stack.group})`;

/** The pid and name of a process that listens on `port`; undefined when none does. */
function listener(port: number): { pid: number; name: string } | undefined {
  const pid = Number(spawnSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.split('\n')[0]);
  if (!pid) return undefined;
  return { pid, name: spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() };
}

/** Refuses a start whose ports a running stack or another process holds, naming what holds them. */
function assertPortsFree(repoRoot: string, offset: number, ports: number[]): void {
  const stopHint = (stack: Stack) => `${stack.offset ? `DEV_PORT_OFFSET=${stack.offset} ` : ''}pnpm cella dev stop`;
  const stacks = liveStacks();
  const own = stacks.find((stack) => stack.checkout === repoRoot && stack.offset === offset);
  if (own) throw new Error(`this checkout's stack runs at ${own.url}, process group ${own.group}: \`${stopHint(own)}\` ends it`);
  for (const stack of stacks) {
    const port = stack.ports.find((taken) => ports.includes(taken));
    if (port) throw new Error(`port ${port} belongs to the stack at ${describe(stack)}: \`pnpm cella dev stop --group ${stack.group}\` ends it`);
  }
  for (const port of ports) {
    const holder = listener(port);
    if (holder)
      throw new Error(
        `port ${port} is held by ${holder.name} (pid ${holder.pid}), which no \`cella dev\` started: \`pnpm killports\` frees this checkout's ports`,
      );
  }
}

/** Runs `command` as the stack: in its own process group, recorded while it runs, its output also in a log. */
async function startStack(repoRoot: string, command: string[]): Promise<number> {
  if (command.length === 0) throw new Error('name the command that runs the stack after `--`, such as `cella dev -- pnpm stack`');
  const app = await loadAppConfig(repoRoot, appConfigSchema);
  const ports = Object.values(app.services)
    .filter((service) => service.enabled)
    .flatMap(({ port, internalPort }) => (internalPort === undefined ? [port] : [port, internalPort]));
  assertPortsFree(repoRoot, app.devPortOffset, ports);

  const logDir = toolDir(repoRoot, 'dev');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `stack-${app.devPortOffset}.log`);
  // The log holds what the servers print, a session or a key among it
  const log = createWriteStream(logPath, { mode: 0o600 });
  // Piped output loses its colors unless asked for; the log gets the text without them
  const color = process.stdout.isTTY && process.env.FORCE_COLOR === undefined ? { FORCE_COLOR: '1' } : {};
  const [program, ...args] = command;
  // In a process group of its own one signal reaches every server and watcher. It gets no stdin: a group outside the
  // terminal's foreground is stopped when it reads there.
  const child = spawn(program, args, { cwd: repoRoot, env: { ...process.env, ...color }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number>((done) => {
    child.once('error', (error) => {
      spinnerFail(`${program}: ${error.message}`);
      done(127);
    });
    // A shell reports a process a signal ended as 128 plus the signal's number
    child.once('exit', (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
  const group = child.pid;
  const start = group === undefined ? undefined : leaderStart(group);
  if (group === undefined || start === undefined) {
    log.end();
    return exited;
  }

  recordStack({
    group,
    launcher: process.pid,
    leaderStart: start,
    checkout: repoRoot,
    app: rootPackage(repoRoot).name,
    offset: app.devPortOffset,
    url: app.frontendUrl,
    ports,
    log: logPath,
    command,
    startedAt: Date.now(),
  });
  let ending: Promise<void> | undefined;
  // Ctrl-C, a stop from elsewhere and a command that ends by itself all end the whole group, its stragglers included
  const end = () =>
    (ending ??= endGroup(group, stopGraceMs).then(() => {
      forgetStack(group);
      log.end();
    }));
  const forget = onShutdown(end);

  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    stream.setEncoding('utf8');
    stream.on('data', (text: string) => {
      target.write(text);
      log.write(stripVTControlCharacters(text));
    });
  }
  printStep('stack', `${app.frontendUrl}, process group ${group}`);
  printStep('log', logPath);
  console.info(pc.dim('  ctrl-c stops it, as `pnpm cella dev stop` does from another terminal\n'));

  const code = await exited;
  await end();
  forget();
  return code;
}

function printStatus(repoRoot: string, all: boolean): number {
  const stacks = liveStacks();
  const shown = all ? stacks : stacks.filter((stack) => stack.checkout === repoRoot);
  if (shown.length === 0) {
    const elsewhere = stacks.length > 0 && !all ? `, ${stacks.length} of other checkouts do: \`pnpm cella dev status --all\`` : '';
    console.info(pc.dim(all ? 'No cella dev stack runs on this machine' : `No cella dev stack of this checkout runs${elsewhere}`));
  }
  const usage = groupUsage();
  let stacksMemory = 0;
  for (const stack of shown) {
    const { processes = 0, memory = 0 } = usage.get(stack.group) ?? {};
    stacksMemory += memory;
    const orphaned = launcherHolds(stack) ? '' : pc.yellow('  its cella dev is gone, `stop` ends it');
    const where = all ? `${stack.app}, ${tilde(stack.checkout)}, ` : '';
    printStep(
      stack.url,
      `${where}offset ${stack.offset}, group ${stack.group}: ${processes} processes, ${size(memory)}, up ${age(stack.startedAt)}${orphaned}`,
    );
  }
  const swap = swapUsage();
  const swapLine = swap ? `, swap ${size(swap.used)} used of ${size(swap.total)}` : '';
  // Resident memory counts a page that processes share once per process: the sum is an upper bound
  console.info(pc.dim(`\nThese stacks hold ${size(stacksMemory)} of the machine's ${size(totalmem())}${swapLine}`));
  return 0;
}

/** Ends the stack of this checkout at its port offset, or the one `group` names. */
async function stopStack(repoRoot: string, group: number | undefined): Promise<number> {
  const stacks = liveStacks();
  let stack: Stack | undefined;
  if (group !== undefined) {
    stack = stacks.find((candidate) => candidate.group === group);
    if (!stack) throw new Error(`no cella dev stack runs in process group ${group}: \`pnpm cella dev status --all\` lists them`);
  } else {
    const { devPortOffset } = await loadAppConfig(repoRoot, appConfigSchema);
    stack = stacks.find((candidate) => candidate.checkout === repoRoot && candidate.offset === devPortOffset);
    if (!stack) {
      printStep('stopped', pc.dim(`no stack of this checkout runs at port offset ${devPortOffset}`));
      return 0;
    }
  }
  // The launcher ends the group and drops its record on SIGTERM; a group without one is ended here
  if (launcherHolds(stack)) process.kill(stack.launcher, 'SIGTERM');
  else await endGroup(stack.group, stopGraceMs);
  if (!(await untilGroupGone(stack.group, stopGraceMs + 5000))) killGroup(stack.group, 'SIGKILL');
  forgetStack(stack.group);
  printStep('stopped', describe(stack));
  return 0;
}

export const devCommand: Command<DevOptions, DevOptions['job']> = {
  name: 'dev',
  group: 'develop',
  // The app runs it through its own `pnpm dev`
  inMenu: () => false,
  description: "run the app's dev stack with a record: a second start refuses and names the running one",
  summary: 'the dev stack, recorded while it runs',
  jobs: [
    ['start', 'run the command after `--` as the stack, until ctrl-c'],
    ['status', "this checkout's stacks with their processes and memory, and the machine's"],
    ['stop', 'end a stack whole, one whose cella dev was killed included'],
  ],
  options: [
    ['--all', "every app's stacks on this machine", 'status'],
    ['--group <id>', 'the stack in this process group, of any checkout', 'stop'],
  ],
  passthrough: ['command', 'after `--`: the command that runs the stack'],
  parse: ({ job, opts, passthrough }) => {
    if (job !== 'start' && passthrough.length > 0) throw new Error(`${job} takes no command`);
    const group = opts.group === undefined ? undefined : Number(opts.group);
    if (group !== undefined && !(Number.isInteger(group) && group > 1)) throw new Error('--group takes a process group id that `status --all` lists');
    return { job, all: opts.all === true, group, command: passthrough };
  },
  run: (repoRoot, options) => {
    if (options.job === 'status') return Promise.resolve(printStatus(repoRoot, options.all));
    if (options.job === 'stop') return stopStack(repoRoot, options.group);
    return startStack(repoRoot, options.command);
  },
};
