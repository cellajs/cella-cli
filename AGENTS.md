# Agent guidelines (AGENTS.md)

`@cellajs/cli`, the command line of apps built from the [cella template](https://github.com/cellajs/cella). The [README](./README.md) maps its commands.

## Commits & PRs

- **PR size**: a PR that adds more lines than it removes ends its description with a `## Size` section: the table `pnpm -s start stats --since origin/main --md` prints, then one line per kind that grew saying what those lines are for (for source, how much is comments; for tests, which of the four reasons in cella's [Testing](https://github.com/cellajs/cella/blob/main/cella/TESTING.md#goals) each new test file serves). Lines without a reason are the first to cut.
