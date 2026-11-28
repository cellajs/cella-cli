# @cellajs/cli

The command line of apps built from the [cella template](https://github.com/cellajs/cella): a testbed and the tools that
run on it, the style check, upgrades from upstream cella that keep your customizations, and the engine that deploys the
app to Scaleway.

## Usage

From the app's root, run `pnpm cella` for a menu of commands, or name one: `pnpm cella upgrade`.
`pnpm cella <command> --help` lists a command's jobs and options.

The CLI runs on macOS and Linux with Node 26 or later, and calls `git` and `pnpm` from the PATH.

| Group | Command | What it does |
|-------|---------|--------------|
| Develop | `dev` | Run the dev stack and record it: a second start refuses, `status --all` lists every app's stacks |
| | `testbed` | A throwaway copy of the app on its own seeded database and ports, beside `pnpm dev` |
| | `bench` | Load-test the running app and check what the stack did with the load |
| | `a11y` | Audit the app against WCAG 2.2 AA and keep the conformance ledger |
| | `shoot` | Shoot the marketing screenshots |
| | `i18n` | Translation status, unused keys and renames |
| | `stats` | Count files by kind, in the repository or in what a branch changed |
| Security | `audit` | Outdated packages, runtime pins and security overrides; `audit fix` updates them |
| | `pentest` | Scan a throwaway testbed: a cross-tenant access probe, then Nuclei and ZAP |
| Operate | `infra` | Install, apply and deploy the app's environments on Scaleway: [src/infra](src/infra/README.md) |
| Upstream | `analyze` | A dry run of the next upgrade |
| | `upgrade` | Merge upstream onto a fresh branch and open a squash-merge PR |
| | `align` | The upstream alignments this app has not handled yet |
| | `adopt` | Pull and adopt changes from local forks |
| Gate | `style` | The style check: terminology, docs, comments and frontend code |

## Dev stacks

`cella dev -- <command>` runs an app's dev stack: the command in a process group of its own, recorded while it runs
with its checkout, port offset, ports, URL and log. The records live in the account's home directory, where every app
and checkout on the machine reads them.

A second start in one checkout at one port offset refuses and names the stack that runs, as does a start on ports
another stack or another process holds. Ctrl-C ends the whole group, and a command that exits takes the rest of its
group with it.

`cella dev status` lists this checkout's stacks with their processes and memory, and `--all` every app's, with the
machine's swap. `cella dev stop` ends this checkout's stack at its port offset, and `--group` any stack the status lists,
one whose `cella dev` was killed included.

## Testbed

`pnpm testbed` starts a copy of the app on a database and ports of its own, beside `pnpm dev`: the backend, the
workers, the relay and a built frontend. The database is seeded once and migrated on every start, and ctrl-c stops it
all. It needs Docker and a `db_testbed` service in `backend/compose.yaml`.

`pnpm testbed -- <command>` runs a command against a testbed, with its ports and database URLs in the environment.
`pnpm testbed stop` stops one that was left behind.

## Tools

A tool's engine ships in this package, and what is app-specific sits in the app's `cella/` folder: `cella/<tool>.ts`,
which each upgrade brings from the template, and an optional `cella/<tool>.app.ts` for the app's own entries, which no
upgrade touches. Results stay in the git directory, out of `git status`. The tools that open pages use the app's
Playwright, with Chromium installed once: `pnpm --filter frontend exec playwright install chromium`.

### Bench

`pnpm cella bench` load-tests the running app, or a [testbed](#testbed) with `--isolated`, and passes on what the stack
did with the load. Scenarios, checks and baselines:
[backend/bench](https://github.com/cellajs/cella/blob/main/backend/bench/README.md) in the template.

### a11y

`pnpm cella a11y` audits the app against WCAG 2.2 AA on a testbed and fills the conformance ledger,
`cella/a11y-ledger.json`. A row becomes Supports only when all its checks ran and none is manual; the rest stay open for
a reviewer, who records each decision with `a11y decide`. `a11y report` renders the ledger as a draft VPAT. States,
partial runs and publishing: [src/a11y](src/a11y/README.md).

### Screenshots

`pnpm cella shoot` shoots the marketing screenshots `cella/screenshots.ts` lists on a testbed, a light and a dark file
each, over the files the app ships. Ids pick some shots (`pnpm cella shoot settings`), and `--out <dir>` writes a trial
run elsewhere.

### Pentest

`pnpm cella pentest` scans a throwaway testbed of your app before a release: a probe that calls every scoped read route
signed out, as an outsider and as the least role, then Nuclei and ZAP. `cella/pentest.ts` describes the app and the
findings it accepts. `pnpm cella pentest report` prints the last run, and `--pdf` writes it for a customer. Checks and
results: [src/pentest](src/pentest/README.md).

### Translations

`pnpm cella i18n` checks the locale files against English, `i18n unused` lists the keys no code names, and
`i18n rename <ns:old> <ns:new>` renames a key in every language and in the code. What each reports:
[src/i18n](src/i18n/README.md).

### Drive library

`@cellajs/cli/drive` is the browser layer the tools share, for an app's own scripts: `loadPlaywright()`,
`mintSession(email)`, which signs in a seeded user, and `signOut(session)`. A script run with
`pnpm testbed -- node <script>` drives the testbed.

## Style

`pnpm cella style` is the style check an app runs as a gate, in `pnpm check` and in CI: terminology, docs, comments and
frontend code that Biome cannot check. It exits 1 on any finding. An app lists its exceptions in
`shared/config/style-exceptions.ts`. The rules and the exceptions: [src/style](src/style/README.md).

## Upgrades

`cella/cella.config.ts` says how upgrades treat the app's files. A new app gets it from the template, and no upgrade
merges it:

```typescript
import { defineConfig } from '@cellajs/cli/config';

export default defineConfig({
  upstreamUrl: 'https://github.com/cellajs/cella.git',
  trunk: 'main', // your main branch: upgrade branches are cut from it and their PRs go into it
  packageJsonKeys: ['dependencies', 'devDependencies', 'scripts'],
  ignored: ['README.md', 'shared/config'],
  pinned: ['backend/src/modules.ts'],
});
```

A file no entry names follows upstream. `ignored` keeps a path out of upgrades, and `pinned` keeps the app's version
whole, dropping upstream's changes to it: `analyze` lists those for you to adopt by hand.

`pnpm cella analyze` is a dry run of the next upgrade. `pnpm cella upgrade` merges the latest cella release on a fresh
branch, one stage per run, and never commits to the trunk:

1. The first run merges and stops with the merge staged. Read what arrived, scripts and workflows first, since the next
   run executes it, and resolve the conflicts.
2. The second run installs, runs `pnpm check`, commits and stops, for follow-up commits.
3. The third run pushes and opens a squash-merge PR.

When upstream changes a pattern app code has to follow, it ships an
[alignment](https://github.com/cellajs/cella/blob/main/cella/alignments/README.md): steps and sometimes a codemod.
`pnpm cella align` lists the ones the app has not handled, `align run <id>` runs a codemod, and `align mark <id>`
records one as handled.

Tracking modes, merge rules, file statuses, the package.json merge and adopting from forks:
[src/upstream](src/upstream/README.md).

## Audit

`pnpm cella audit` reports outdated packages, runtime pins (Node, pnpm, Docker images), the tools on this machine and
open advisories. `pnpm cella audit fix` asks which to update, then keeps only the security overrides a current advisory
needs, asking before a breaking fix. An override without a version selector (`pkg`, not `pkg@<1.2.3`) is yours and
stays. Pins, overrides and each outcome: [src/audit](src/audit/README.md).

## Stats

`pnpm cella stats --since origin/main --md` prints what the branch committed by kind of file, as a markdown table for a
PR description. Without `--since` it counts the whole repository, and `-V` lists every file.
