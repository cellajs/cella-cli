import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseEnv } from 'node:util';
import type { ToolCommand } from '../config/types';
import { loadAppFacts, loadLocalDatabases, toolDir } from '../utils/app-facts';
import pc from '../utils/colors';
import { createSpinner, printStep, spinnerFail } from '../utils/display';
import { getEnvSnapshot } from '../utils/env';
import { onShutdown } from '../utils/signals';

/** Above the checkout's own ports, clear of `pnpm dev` and of a second stack at offset 50 or 60. */
const PORT_SHIFT = 70;
/** How long the servers get to answer, the frontend build included. */
const STARTUP_TIMEOUT_MS = 5 * 60_000;
/** How long the servers get to exit before they are killed. */
const STOP_TIMEOUT_MS = 10_000;
/** The database's name in `shared/src/local-database.ts` and its service in `backend/compose.yaml`. */
const DATABASE = 'testbed';
const DATABASE_SERVICE = 'db_testbed';

export interface TestbedOptions {
  job: 'start' | 'stop';
  /** Start from an empty database. */
  fresh: boolean;
  /** What to run against the testbed: the words after `--`. */
  command: string[];
}

/** A testbed a tool runs against: where it answers, and the env that points a process at it. */
export interface TestbedHandle {
  frontendUrl: string;
  backendUrl: string;
  /** `DEV_PORT_OFFSET` of the testbed's servers. */
  portOffset: number;
  /** Ports, database URLs and the seeded admin, over this process's own env. */
  env: NodeJS.ProcessEnv;
  /** The database's container, for `docker exec`. */
  container: string;
}

interface Testbed extends TestbedHandle {
  forkPath: string;
  databasePort: number;
  /** Every port its servers listen on. */
  ports: number[];
  yjs: boolean;
  /** `<git common dir>/cella-testbed/`: the lock and the servers' log. One per repository, as the database is. */
  stateDir: string;
}

/** The process that holds a running testbed, written to `lock.json` while it runs. */
interface Lock {
  pid: number;
  forkPath: string;
  frontendUrl: string;
}

const shiftPort = (url: string) => {
  const next = new URL(url);
  next.port = String(Number(next.port) + PORT_SHIFT);
  return next.toString().replace(/\/$/, '');
};

async function resolveTestbed(forkPath: string): Promise<Testbed> {
  const [facts, databases] = await Promise.all([loadAppFacts(forkPath), loadLocalDatabases(forkPath)]);
  const databasePort = databases.port(DATABASE);
  if (!Number.isInteger(databasePort)) {
    throw new Error('shared/src/local-database.ts names no testbed database: upgrade the app from cella first');
  }
  const composeEnv = databases.composeEnv();
  const envFile = join(forkPath, 'backend/.env');
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const portOffset = facts.devPortOffset + PORT_SHIFT;

  return {
    forkPath,
    frontendUrl: shiftPort(facts.frontendUrl),
    backendUrl: shiftPort(facts.backendUrl),
    databasePort,
    portOffset,
    env: {
      // The seed creates the admin that backend/.env names, and a command signs in as that user
      ...(fileEnv.ADMIN_EMAIL ? { ADMIN_EMAIL: fileEnv.ADMIN_EMAIL } : {}),
      ...getEnvSnapshot(),
      ...composeEnv,
      NODE_ENV: 'development',
      DATABASE_URL: databases.url(DATABASE, 'runtime_role'),
      DATABASE_ADMIN_URL: databases.url(DATABASE, 'postgres'),
      DATABASE_CDC_URL: databases.url(DATABASE, 'admin_role'),
      DEV_PORT_OFFSET: String(portOffset),
      // The system pages need system admin access from this machine
      SYSTEM_ADMIN_IP_ALLOWLIST: '*',
    },
    ports: Object.values(facts.services).flatMap(({ port, internalPort }) =>
      (internalPort === undefined ? [port] : [port, internalPort]).map((value) => value + PORT_SHIFT),
    ),
    container: `${composeEnv.PROJECT_SLUG}_${DATABASE_SERVICE}`,
    yjs: facts.services.yjs?.enabled ?? false,
    stateDir: toolDir(forkPath, 'testbed', 'repository'),
  };
}

const lockPath = (testbed: Testbed) => join(testbed.stateDir, 'lock.json');
const logPath = (testbed: Testbed) => join(testbed.stateDir, 'testbed.log');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock of a testbed whose process still runs. */
function readLock(testbed: Testbed): Lock | undefined {
  try {
    const lock: Lock = JSON.parse(readFileSync(lockPath(testbed), 'utf8'));
    return isAlive(lock.pid) ? lock : undefined;
  } catch {
    return undefined;
  }
}

const reachable = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(2000) }).then(
    (response) => response.status < 500,
    () => false,
  );

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function compose(testbed: Testbed, args: string[], stdio: 'inherit' | 'ignore' = 'ignore'): boolean {
  const composeArgs = ['compose', '-f', 'backend/compose.yaml', '--profile', DATABASE, ...args];
  return spawnSync('docker', composeArgs, { cwd: testbed.forkPath, env: testbed.env, stdio }).status === 0;
}

/** The database container and its volume go, so the next start migrates and seeds from nothing. */
function removeDatabase(testbed: Testbed): void {
  const inspect = spawnSync('docker', ['inspect', '-f', '{{range .Mounts}}{{.Name}} {{end}}', testbed.container], {
    encoding: 'utf8',
  });
  if (inspect.status !== 0) return;
  spawnSync('docker', ['rm', '-f', testbed.container], { stdio: 'ignore' });
  for (const volume of inspect.stdout.trim().split(' ').filter(Boolean)) {
    spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
  }
}

function isSeeded(testbed: Testbed): boolean {
  const users = spawnSync(
    'docker',
    ['exec', testbed.container, 'psql', '-U', 'postgres', '-tAc', 'select count(*) from users'],
    { encoding: 'utf8' },
  );
  return users.status === 0 && Number(users.stdout.trim()) > 0;
}

/** Process groups of whatever listens on the testbed's ports: what a testbed left behind still runs. */
function listenerGroups(testbed: Testbed): Set<number> {
  const groups = new Set<number>();
  for (const port of testbed.ports) {
    const pids = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout;
    for (const pid of pids.split('\n').filter(Boolean)) {
      const group = Number(spawnSync('ps', ['-o', 'pgid=', '-p', pid], { encoding: 'utf8' }).stdout.trim());
      if (group > 1) groups.add(group);
    }
  }
  return groups;
}

function killGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // It already exited
  }
}

function logTail(testbed: Testbed, lines = 30): string {
  if (!existsSync(logPath(testbed))) return '';
  return readFileSync(logPath(testbed), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

/** Waits until the frontend and the API answer; ends early with `failure()` once `alive()` turns false. */
async function untilAnswering(testbed: Testbed, alive: () => boolean, failure: () => string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!((await reachable(testbed.frontendUrl)) && (await reachable(`${testbed.backendUrl}/health`)))) {
    if (!alive()) throw new Error(failure());
    if (Date.now() > deadline) throw new Error(`nothing answered at ${testbed.frontendUrl} within five minutes`);
    await sleep(2000);
  }
}

/** A started testbed: `exited` settles when its servers exit by themselves. */
interface Started {
  stop: () => Promise<void>;
  exited: Promise<void>;
}

/** Starts the database and the servers, and resolves once both answer; `drop` removes the database on stop. */
async function startTestbed(testbed: Testbed, fresh: boolean, drop = false): Promise<Started> {
  if (await reachable(testbed.frontendUrl)) {
    throw new Error(
      `something already answers at ${testbed.frontendUrl}: \`pnpm cella testbed stop\` ends a testbed left behind`,
    );
  }
  mkdirSync(testbed.stateDir, { recursive: true });
  // Written before the database starts, so a second start during the seed finds it
  writeFileSync(
    lockPath(testbed),
    JSON.stringify({ pid: process.pid, forkPath: testbed.forkPath, frontendUrl: testbed.frontendUrl } satisfies Lock),
  );
  const log = openSync(logPath(testbed), 'w');
  let stack: ChildProcess | undefined;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const spinner = createSpinner('stopping the testbed');
    const pid = stack?.pid;
    if (pid !== undefined && stack?.exitCode === null) {
      const exited = new Promise((done) => stack?.once('exit', done));
      killGroup(pid, 'SIGTERM');
      if (!(await Promise.race([exited.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)]))) {
        killGroup(pid, 'SIGKILL');
      }
    }
    if (drop) removeDatabase(testbed);
    else compose(testbed, ['stop', DATABASE_SERVICE]);
    rmSync(lockPath(testbed), { force: true });
    closeSync(log);
    spinner.stop();
    const database = drop ? 'removed, the next start seeds a new one' : 'kept for the next start';
    printStep('stopped', pc.dim(`database container ${testbed.container} ${database}`));
  };
  const forget = onShutdown(stop);

  try {
    if (fresh) removeDatabase(testbed);
    const spinner = createSpinner(`starting the database on port ${testbed.databasePort}`);
    if (!compose(testbed, ['up', '-d', '--wait', DATABASE_SERVICE])) {
      throw new Error('the testbed database did not start: is Docker running?');
    }

    // A new volume gets the schema and the seed data; a kept one gets the migrations added since
    const seeded = isSeeded(testbed);
    spinner.text = seeded ? 'migrating the database' : 'migrating and seeding the database (first start only)';
    const prepare = seeded ? ['--filter', 'backend', 'migrate'] : ['seed'];
    const prepared = spawnSync('pnpm', prepare, {
      cwd: testbed.forkPath,
      env: testbed.env,
      stdio: ['ignore', log, log],
    });
    if (prepared.status !== 0) throw new Error(`\`pnpm ${prepare.join(' ')}\` failed:\n${logTail(testbed)}`);
    printStep('database', `${seeded ? 'migrated' : 'seeded'}, port ${testbed.databasePort}`);

    // `pnpm offline` starts no Yjs relay; with one the editors show their usual sync status
    const relay = testbed.yjs ? 'pnpm --filter yjs-worker dev & ' : '';
    stack = spawn('sh', ['-c', `${relay}pnpm offline`], {
      cwd: testbed.forkPath,
      env: testbed.env,
      // Its own process group, so one signal stops the servers, the workers and the frontend preview together
      detached: true,
      stdio: ['ignore', log, log],
    });

    createSpinner('building the frontend and starting the servers');
    const servers = stack;
    await untilAnswering(
      testbed,
      () => servers.exitCode === null,
      () => `the servers stopped while starting:\n${logTail(testbed)}`,
    );
    printStep('servers', `${testbed.frontendUrl}, ports shifted by ${testbed.portOffset}`);
  } catch (error) {
    await stop();
    forget();
    throw error;
  }

  const running = stack;
  return {
    stop: async () => {
      await stop();
      forget();
    },
    // A stop ends the servers too; only an exit nobody asked for settles this
    exited: new Promise((done) => running.once('exit', () => !stopped && done())),
  };
}

/** Runs `command` in the app's root with `env`, in the foreground; resolves to its exit code. */
export function runCommand(forkPath: string, env: NodeJS.ProcessEnv, command: string[]): Promise<number> {
  const [program, ...args] = command;
  const child = spawn(program, args, { cwd: forkPath, env, stdio: 'inherit' });
  return new Promise((done) => {
    child.once('error', (error) => {
      spinnerFail(`${program}: ${error.message}`);
      done(127);
    });
    // A shell reports a process a signal ended as 128 plus the signal's number
    child.once('exit', (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
}

async function stopTestbed(testbed: Testbed): Promise<number> {
  const lock = readLock(testbed);
  if (lock) {
    // The process that holds it stops its servers and the database on SIGTERM
    process.kill(lock.pid, 'SIGTERM');
    const deadline = Date.now() + STOP_TIMEOUT_MS + 5000;
    while (isAlive(lock.pid) && Date.now() < deadline) await sleep(250);
  }
  const groups = listenerGroups(testbed);
  for (const group of groups) killGroup(group, 'SIGTERM');
  compose(testbed, ['stop', DATABASE_SERVICE]);
  rmSync(lockPath(testbed), { force: true });
  printStep(
    'stopped',
    lock || groups.size > 0 ? (lock?.frontendUrl ?? testbed.frontendUrl) : pc.dim('no testbed was running'),
  );
  return 0;
}

/** The lock of a running testbed this checkout may use; refuses one another checkout holds. */
function ownLock(testbed: Testbed): Lock | undefined {
  const lock = readLock(testbed);
  if (lock && lock.forkPath !== testbed.forkPath) {
    throw new Error(`a testbed of ${lock.forkPath} uses the database: \`pnpm cella testbed stop\` ends it`);
  }
  return lock;
}

/**
 * Runs `use` against a testbed: the one this checkout holds, once it answers, else one started for it and stopped after,
 * ctrl-c included. A `destructive` command writes and deletes rows, so it gets a testbed of its own on a new database,
 * removed after the run.
 * @throws for a destructive command while any testbed runs
 */
export async function withTestbed<T>(
  forkPath: string,
  use: (testbed: TestbedHandle) => Promise<T>,
  { fresh = false, destructive = false } = {},
): Promise<T> {
  const testbed = await resolveTestbed(forkPath);
  const lock = ownLock(testbed);
  if (lock && destructive) {
    throw new Error(
      `a testbed runs at ${lock.frontendUrl}: this command needs one of its own, so stop that one first (\`pnpm cella testbed stop\`)`,
    );
  }
  if (lock) {
    await untilAnswering(
      testbed,
      () => isAlive(lock.pid),
      () => 'the testbed stopped while starting',
    );
    return use(testbed);
  }
  const started = await startTestbed(testbed, fresh || destructive, destructive);
  try {
    return await use(testbed);
  } finally {
    await started.stop();
  }
}

async function runTestbed(forkPath: string, options: TestbedOptions): Promise<number> {
  if (options.job === 'stop') return stopTestbed(await resolveTestbed(forkPath));
  if (options.command.length > 0) {
    return withTestbed(forkPath, (testbed) => runCommand(forkPath, testbed.env, options.command), options);
  }

  const testbed = await resolveTestbed(forkPath);
  const lock = ownLock(testbed);
  if (lock) {
    throw new Error(
      `a testbed already runs at ${lock.frontendUrl}: \`pnpm cella testbed -- <command>\` runs against it`,
    );
  }
  const started = await startTestbed(testbed, options.fresh);
  console.info();
  console.info(`  ${pc.bold(testbed.frontendUrl)}`);
  console.info(`  ${pc.dim('run a command against it:')} pnpm cella testbed -- <command>`);
  console.info(`  ${pc.dim('servers log:')} ${logPath(testbed)}`);
  console.info(`  ${pc.dim('ctrl-c stops it')}`);
  console.info();
  // Ctrl-C stops it through the shutdown handler; reaching the next line means the servers exited by themselves
  await started.exited;
  spinnerFail(`the servers stopped by themselves:\n${logTail(testbed)}`);
  await started.stop();
  return 1;
}

export const testbedCommand: ToolCommand<TestbedOptions> = {
  name: 'testbed',
  group: 'develop',
  description: 'a throwaway copy of the app on its own seeded database and ports, beside pnpm dev',
  jobs: [
    ['start', 'start it and hold it until ctrl-c'],
    ['stop', 'stop the testbed that runs, or one left behind'],
  ],
  options: [['--fresh', 'start from an empty database: migrate and seed it again']],
  passthrough: [
    'command',
    "after `--`: run it against the testbed (this checkout's running one, else one started for it and stopped after)",
  ],
  parse: ({ job = 'start', opts, passthrough }) => {
    if (job !== 'start' && job !== 'stop') throw new Error(`unknown job '${job}'. expected one of: start, stop`);
    if (job === 'stop' && passthrough.length > 0) throw new Error('stop takes no command');
    return { job, fresh: opts.fresh === true, command: passthrough };
  },
  run: runTestbed,
};
