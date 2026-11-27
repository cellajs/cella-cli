import { afterEach, describe, expect, it, vi } from 'vitest';
import { operatorActions } from './lib/operator-actions';
import { ExitCodeError } from './lib/utils/errors';
import { runInfra, runTask, tasks } from './run';

// The CLI's import loads the app's config: an app whose config did not load got an import error where it asked for help
vi.mock('./cli/infra-cli', () => {
  throw new Error('the help loaded the app config');
});

it('prints a help page that names every action, without loading the app config', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await runInfra(['apply', '--help'])).toBe(0);
  const page = String(write.mock.calls[0]?.[0]);
  for (const id of Object.keys(operatorActions)) expect(page).toMatch(new RegExp(`^ {2}${id} `, 'm'));
  write.mockRestore();
});

// `deploy` named both, and `pnpm cella infra deploy` ran the task where the docs promised `deploy-now`: a task is looked up first
it('names no task by the id of an operator action', () => {
  expect(Object.keys(tasks).filter((name) => Object.hasOwn(operatorActions, name))).toEqual([]);
});

describe('runTask', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  // The release check sets the exit code when an apply is owed: through `cella infra` it ended 0, and CI passed a release that owed one
  it('ends with the exit code a task set without throwing', async () => {
    const owes = async () => {
      process.exitCode = 1;
    };
    expect(await runTask(owes, [])).toBe(1);
  });

  it('ends 0 after a task that sets none, and with the code of an ExitCodeError it throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runTask(async () => {}, [])).toBe(0);
    expect(
      await runTask(async () => {
        throw new ExitCodeError('the run failed', 3);
      }, []),
    ).toBe(3);
  });
});
