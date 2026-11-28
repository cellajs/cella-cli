import { describe, expect, it } from 'vitest';
import type { AgentState } from './health';
import { type ContainerReading, type RestartRecord, type RestartVerdict, restartVerdict } from './liveness';

const minute = 60_000;
const now = Date.parse('2026-11-27T13:00:00Z');
const ago = (minutes: number) => now - minutes * minute;
const startedAt = now - 50_000;

/** A check Docker ran this long after the container's start: exit -1 got no answer, 1 an error answer, 0 a 2xx. */
const check = (secondsAfterStart: number, exitCode: number) => ({
  start: startedAt + secondsAfterStart * 1000,
  exitCode,
  output: exitCode === -1 ? 'Health check exceeded timeout (5s)' : '',
});
const unhealthy = (...checks: ReturnType<typeof check>[]) => ({ status: 'unhealthy', checks });

const hung = (overrides: Partial<ContainerReading> = {}): ContainerReading => ({
  id: 'f00d',
  name: 'app-backend-1',
  status: 'running',
  startedAt,
  restartPolicy: 'unless-stopped',
  health: unhealthy(check(10, 0), check(20, -1), check(30, -1), check(40, -1)),
  ...overrides,
});
const fresh: RestartRecord = { restarts: [], gaveUp: false };
const booted: AgentState = { booted: true, draining: false };
const none: RestartVerdict = { act: 'none' };

describe('whether the agent restarts a container', () => {
  const cases: [rule: string, container: ContainerReading, record: RestartRecord, agent: AgentState, verdict: RestartVerdict][] = [
    ['restarts one whose last three checks got no answer', hung(), fresh, booted, { act: 'restart', silentChecks: 3, restart: 1 }],
    ['waits while two checks in a row got no answer', hung({ health: unhealthy(check(20, 0), check(30, -1), check(40, -1)) }), fresh, booted, none],
    // A dependency that is away answers with an error, and a restart would not bring it back
    ['leaves one that answers with an error', hung({ health: unhealthy(check(20, 1), check(30, 1), check(40, 1)) }), fresh, booted, none],
    [
      'counts no silence an answer broke',
      hung({ health: unhealthy(check(0, -1), check(10, -1), check(20, 1), check(30, -1), check(40, -1)) }),
      fresh,
      booted,
      none,
    ],
    // Docker keeps the health log across a restart
    [
      "counts no check from before the container's start",
      hung({ health: unhealthy(check(-40, -1), check(-30, -1), check(-20, -1), check(30, -1), check(40, -1)) }),
      fresh,
      booted,
      none,
    ],
    [
      'leaves one in its start period',
      hung({ health: { ...unhealthy(check(20, -1), check(30, -1), check(40, -1)), status: 'starting' } }),
      fresh,
      booted,
      none,
    ],
    // Docker shows a paused container unhealthy and runs no check of it: a person paused it
    ['leaves a paused one', hung({ status: 'paused' }), fresh, booted, none],
    ['leaves one Docker restarts itself', hung({ status: 'restarting' }), fresh, booted, none],
    ["leaves one the machine's unit supervises, and a one-shot companion", hung({ restartPolicy: 'no' }), fresh, booted, none],
    ['leaves one without a healthcheck', hung({ health: undefined }), fresh, booted, none],
    ['restarts nothing before the boot completed', hung(), fresh, { booted: false, draining: false }, none],
    ['restarts nothing once a drain began', hung(), fresh, { booted: true, draining: true }, none],
    [
      'defers a second restart within two minutes of the first',
      hung(),
      { restarts: [ago(1)], gaveUp: false },
      booted,
      { act: 'defer', until: ago(-1) },
    ],
    [
      'restarts again once the backoff passed',
      hung(),
      { restarts: [ago(3)], gaveUp: false },
      booted,
      { act: 'restart', silentChecks: 3, restart: 2 },
    ],
    [
      'doubles the backoff with each restart in the window',
      hung(),
      { restarts: [ago(20), ago(3)], gaveUp: false },
      booted,
      { act: 'defer', until: ago(-1) },
    ],
    [
      'gives up on one that needs a fourth restart within the hour',
      hung(),
      { restarts: [ago(50), ago(40), ago(30)], gaveUp: false },
      booted,
      { act: 'give-up', restarts: 3 },
    ],
    [
      'counts no restart older than the hour',
      hung(),
      { restarts: [ago(70), ago(40), ago(30)], gaveUp: false },
      booted,
      { act: 'restart', silentChecks: 3, restart: 3 },
    ],
    ['leaves one it gave up on', hung(), { restarts: [ago(50), ago(40), ago(30)], gaveUp: true }, booted, none],
  ];

  it.each(cases)('%s', (_rule, container, record, agent, verdict) => {
    expect(restartVerdict(container, record, agent, now)).toEqual(verdict);
  });
});
