import { errorMessage } from '../../lib/utils/errors';
import type { AgentState } from './health';
import { type RestartRecord, type WatchEffects, watchContainers } from './liveness';
import type { Manifest } from './manifest';

/** How often the agent reads its manifest: a drain order shows up within about three seconds of the deploy's write. */
const manifestPollMs = 2_000;

/** Manifest reads between two watch rounds: about ten seconds, the longest Docker takes between two checks of a container. */
const watchEveryRounds = 5;

/** What the agent does outside this module, so a test passes its own. */
export interface AgentEffects extends WatchEffects {
  /** The boot sequence: the env file, the archives, `compose up --wait`, the boot account. Throws when the release did not start. */
  boot(): Promise<void>;
  readManifest(): Promise<Manifest>;
  /** Stop the machine's app containers through Compose, which sends each its stop signal and waits its grace period. */
  stopServices(): Promise<void>;
  /** Serve the health ports, answering from the state given. */
  serve(state: () => AgentState): void;
  sleep(ms: number): Promise<void>;
}

/**
 * The agent's life on a machine. It answers the load balancer at once, 503 until the release booted. A manifest that already says drain,
 * as after a reboot of a drained machine, starts nothing. It then reads the manifest every two seconds: on `drain` it answers 503, waits the
 * role's drain seconds while the load balancer lets connections finish, and stops the app containers. A boot that failed leaves it
 * answering 503 until the deploy deletes the machine. Resolves once it drained, or after `rounds` reads in a test; the health ports keep
 * the process alive until the machine goes.
 *
 * Once the boot completed, every fifth read that orders no drain is followed by a watch round, which restarts an app container that stopped
 * answering (liveness.ts). Reads and rounds take turns in this one loop: a drain never begins while a restart is under way.
 */
export async function runAgent(fx: AgentEffects, opts: { drainSeconds: number; pollMs?: number; rounds?: number }): Promise<AgentState> {
  const state: AgentState = { booted: false, draining: false };
  fx.serve(() => state);
  const read = () =>
    fx.readManifest().catch((error: unknown) => {
      fx.log('manifest-unread', { message: errorMessage(error) });
      return undefined;
    });
  const drain = async () => {
    state.draining = true;
    fx.log('drain', { seconds: opts.drainSeconds });
    await fx.sleep(opts.drainSeconds * 1000);
    await fx.stopServices().catch((error: unknown) => fx.log('stop-failed', { message: errorMessage(error) }));
    fx.log('drained');
  };
  if ((await read())?.drain) {
    await drain();
    return state;
  }
  const booting = fx.boot().then(
    () => {
      state.booted = true;
      fx.log('serving');
    },
    (error: unknown) => fx.log('boot-failed', { message: errorMessage(error) }),
  );
  const records = new Map<string, RestartRecord>();
  for (let round = 0; opts.rounds === undefined || round < opts.rounds; round++) {
    await fx.sleep(opts.pollMs ?? manifestPollMs);
    if ((await read())?.drain) {
      await drain();
      break;
    }
    if (state.booted && (round + 1) % watchEveryRounds === 0) await watchContainers(fx, state, records);
  }
  await booting;
  return state;
}
