# Agent guidelines (AGENTS.md)

`@cellajs/cli`, the command line of apps built from the [cella template](https://github.com/cellajs/cella). The [README](./README.md) maps its commands.

The template's coding rules apply here too: [Style & naming](https://github.com/cellajs/cella/blob/main/cella/AGENTS.md#style--naming) and [Testing](https://github.com/cellajs/cella/blob/main/cella/AGENTS.md#testing).

## Deploy engine

`src/infra/` is the deploy engine ([its README](./src/infra/README.md)). Two contracts hold across it:

- A task fails by throwing. An `ExitCodeError` names a code other than 1; `runTask` in `src/infra/run.ts` prints the message and ends with that code.
- The agent (`src/infra/agent`) is bundled into one file that every machine runs with nothing installed. It and the `src/infra/lib` files it imports import Node built-ins and each other, never a package.

## Commits & PRs

- **PR size**: a PR that adds more lines than it removes ends its description with a `## Size` section: the table `pnpm -s start stats --since origin/main --md` prints, then one line per kind that grew saying what those lines are for (for source, how much is comments; for tests, which of the four reasons in cella's [Testing](https://github.com/cellajs/cella/blob/main/cella/docs/TESTING.md#goals) each new test file serves). Lines without a reason are the first to cut.
