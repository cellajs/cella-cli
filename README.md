# @cellajs/cli

The command line of apps built from the [cella template](https://github.com/cellajs/cella): a testbed and the tools that
run on it (load tests, an accessibility audit, the marketing screenshots), the style check, and upgrades from upstream
cella that keep your customizations.

## Usage

From your monorepo root, run `pnpm cella` for the interactive menu, or call a command directly:

```bash
pnpm testbed
pnpm cella bench
pnpm cella a11y
pnpm cella analyze
pnpm cella upgrade
pnpm cella audit
```

## Commands

Develop, security and gate commands run without `cella.config.ts`; upstream commands read it first.

| Develop | Description |
|---------|-------------|
| `testbed` | A throwaway copy of the app on its own seeded database and ports, beside `pnpm dev`. `pnpm testbed` runs it, so the menu leaves it out (see [Testbed](#testbed)) |
| `bench` | Load-test the running app with its scenarios and check what the stack did with the load (see [Bench](#bench)) |
| `a11y` | Audit the app against WCAG 2.2 AA on a testbed and keep the conformance ledger (see [a11y](#a11y)) |
| `shoot` | Shoot the app's marketing screenshots on a testbed (see [Screenshots](#screenshots)) |
| `i18n` | Translation status, unused keys and renames across the locale files and the code (see [Translations](#translations)) |

| Security | Description |
|----------|-------------|
| `audit` | Update outdated packages and runtime pins, then rebuild the security overrides from a fresh audit; report the security fixes this machine's Node, pnpm and gh miss |
| `pentest` | Scan a throwaway testbed of the app: a cross-tenant access probe, then Nuclei and ZAP (see [Pentest](#pentest)) |

| Upstream | Description |
|----------|-------------|
| `analyze` | Dry run to see what would change on upgrade. It leaves your files and branches alone but updates git metadata: it fetches upstream and writes `refs/cella/last-upgrade` and a graft for the upgrade base |
| `upgrade` | Merge upstream changes onto a fresh branch, merge package.json and open a squash-merge PR into `main` |
| `align` | List the upstream alignments this app has not handled yet, read them, run their codemods, record them |
| `stats` | Count files by category and workspace package; with `--since <ref>`, count what the current branch changed, by kind of file |
| `adopt` * | Pull and adopt changes from local forks (see [Adopt](#adopt-from-forks)) |

\* `adopt` only appears when you have `forks` configured in `cella.config.ts`.

| Gate | Description |
|------|-------------|
| `style` | The style check: terminology, docs, comments and frontend code; exits 1 on any finding (see [Style](#style)). Scripts and CI run it, so the menu leaves it out |

## CLI options

```bash
pnpm cella [command] [options]
```

Per-command help: `pnpm cella <command> --help`.

| Command | Useful options |
|---------|----------------|
| testbed | `stop`, `--fresh`, `--showcase`, `-- <command>` |
| bench | `[scenario]`, `--all`, `--short`, `--isolated`, `--skip-seed` |
| a11y | `report`, `decide`, `--states <ids>`, `--workers <n>`, `--email <address>`, `--publish`, `--draft`, `--file <path>` |
| shoot | `<ids...>`, `--out <dir>`, `--email <address>` |
| i18n | `unused`, `rename <ns:old> <ns:new>`, `--json` |
| pentest | `report`, `--only <probe,nuclei,zap>`, `--json` |
| analyze | `--list`, `--json`, `--scope <all\|risk\|protected>`, `--all`, `--track <release\|branch>`, `--ref <ref>`, `--unpinned` |
| upgrade | `--track <release\|branch>`, `--ref <ref>`, `--keep-config`, `--unpinned` |
| align | `--all`, `--json`, `--show <id>`, `--extract <id>`, `--run <id> [-- <codemod args>]`, `--mark <ids...>` |
| audit | `--list` |
| adopt | `--fork <name>`, `--json` |
| stats | `--since <ref>`, `--md`, `-V, --verbose` |
| style | `[paths...]` |

| Global flag | Description |
|-------------|-------------|
| `-v, --version` | Output the current version |
| `-h, --help` | Display help for a command |

## Testbed

`pnpm testbed` starts a copy of the app on a database of its own and on ports beside the ones `pnpm dev` uses:
the backend, the workers, the relay and a built frontend. A new database is seeded once and kept, and every start
migrates it, so a branch with migrations works too. The testbed holds until ctrl-c, which stops its servers and its
database container.

| Command | What it does |
|---------|--------------|
| `pnpm testbed` | Start a testbed and hold it |
| `pnpm testbed -- <command>` | Run a command against it: the one this checkout holds, or one started for the command and stopped after. The command gets the testbed's ports (`DEV_PORT_OFFSET`) and database URLs in its environment |
| `pnpm testbed --fresh` | Start from an empty database, seeded again |
| `pnpm testbed --showcase` | Start one on the app's showcase and hold it, for a screenshot review loop |
| `pnpm testbed stop` | Stop the running testbed, or the servers one left behind after a crash |

One testbed runs per app on a machine, since every checkout of the app shares its database: a second start, from
another worktree too, says which checkout holds it. The servers write to `testbed.log` in `.git/cella-testbed/`; a
start that fails prints the end of that log. The testbed needs Docker and an app whose `backend/compose.yaml` has the
`db_testbed` service.

The database holds either the app's seed or its showcase: the curated `backend/scripts/seeds/showcase.json` that the screenshots shoot,
seeded by `pnpm seed showcase`. A start that asks for the other one seeds a new database, and so does every showcase
start, since the showcase's times are relative to its seed. A running testbed serves only commands that want what it
holds.

## Tools and their adapters

A tool's engine ships in this package, and what is app-specific sits in the app's `cella/` folder as an adapter: a base
`cella/<tool>.ts` that comes with each upgrade and describes the template's UI, plus an optional `cella/<tool>.app.ts`
that no upgrade touches, holding only what the app adds, removes (`remove`, by id) or replaces (an entry with a base
id). Without the second file the base runs alone. Both are checked at load, so an adapter that does not fit the
installed CLI fails in seconds, naming the key. They import the app's SDK and run under the app's own `tsx`.

Heavy runtimes come from the app: Playwright from `frontend`, with its Chromium installed once through
`pnpm --filter frontend exec playwright install chromium`. Results stay in the git directory, `.git/cella-<tool>/` in
the main checkout and the worktree's own in a linked one, so they never show in `git status`.

## Bench

`pnpm cella bench` load-tests the app with the scenarios in `backend/bench/scenarios/`. New virtual users arrive on
schedule whether or not earlier ones are done, a live line every five seconds shows what the last interval did, and
the summary ends in checks: the responses the stack rejected, failed users, latency thresholds, the scenario's own
counters, and the app's checks of what the stack recorded. A passing full run is saved as the scenario's baseline and
the next run compares with it.

| Command | What it does |
|---------|--------------|
| `pnpm cella bench` | Pick a scenario from a list, then run it |
| `pnpm cella bench <scenario>` | Run one scenario |
| `pnpm cella bench --all` | Run every scenario in turn, one line each, with a cooldown between them and a table at the end |
| `pnpm cella bench --short` | A smoke run: one user per role, no thresholds and no baseline |
| `pnpm cella bench --isolated` | Run on a [testbed](#testbed), the one this checkout holds or one started for the run |

A run measures the stack this checkout runs with `pnpm dev`, and one run at a time holds it. `--skip-seed` keeps the
bench data of the last run. Baselines, logs and locks live
in `cella-bench/` in the git directory every worktree shares, so `git status` never shows them.

The app's side is `backend/bench/run.ts`, run with the backend's `tsx` so it imports backend modules: it calls
`runBench` from `@cellajs/cli/bench` with the app's preflight, seed and checks around each scenario. A scenario is a
module that default-exports `defineScenario({...})` from the same import; counter and histogram names are typed, so a
misspelled one fails the typecheck.

## a11y

`pnpm cella a11y` audits the app against WCAG 2.2 Level A and AA and fills the conformance ledger,
`cella/a11y-ledger.json`. On a testbed it opens every page and state of the scope once, scans it with axe, runs browser
checks that axe cannot do, and reviews the code for the rest. Each of the 55 criteria gets its evidence and, where the
evidence is complete, a decision. What needs a person goes on a checklist, and a person's decision survives the next
run. The audit takes three to four minutes on top of the testbed's start.

| Command | What it does |
|---------|--------------|
| `pnpm cella a11y` | Run the full audit: axe, browser probes and code checks |
| `pnpm cella a11y --states sign-in,org-members` | Audit some states only; writes `ledger-partial.json` in the results folder, never the ledger |
| `pnpm cella a11y --workers 2` | States audited at the same time (default 4); lower it on a busy machine |
| `pnpm cella a11y report` | Render the ledger as a draft VPAT and a checklist for the manual pass |
| `pnpm cella a11y report --publish` | Put the report where the app serves it and print what the statement needs; refuses a draft |
| `pnpm cella a11y report --publish --draft` | The same while rows still need a person: the statement calls the results provisional |
| `pnpm cella a11y decide --file decisions.json` | Record a reviewer's decisions (an agent's or a person's) with their evidence |

The audit signs in as the seeded admin (`ADMIN_EMAIL` of `.env`) with a minted session and signs it out when it
ends. A visit that fails (a page that redirects, a check that cannot run) is reported, the command exits with an error,
and the run writes `ledger-partial.json`: an incomplete run never replaces the ledger. The failed visit leaves
`failure-<mode>.png` and `failure-<mode>.json` in the state's folder under `review/`: what the page showed, its
console errors and the steps that ran on it before.

**How a run works.** Each state gets one visit in light mode, which runs every check on that one page, and a second in
dark mode, which measures contrast only. A check is a function of an open page that returns findings, and all findings
turn into evidence in one place after every visit.

**What it writes.** The ledger, committed: one row per criterion with its status, the remarks for the report, the
evidence and the checks still open. It carries the product's name (the root package name), and a ledger of another
product is never read, so a new app starts its own with its first full run. In the results folder: raw findings for
fixing (`axe.json`, with every failing element), the draft VPAT and the manual checklist, and a review packet per state.

**How a row is decided.** Each criterion names its checks: axe, a browser probe, a code check or a manual one. Any
failure makes the row Partially Supports. A row becomes Supports or Not Applicable only when all its checks ran and none
of them is manual. Everything else stays open until a reviewer decides it. Contrast is measured in both color modes,
with increased contrast turned on, which the report states: axe decides most text, and what it cannot decide (over a
gradient, an image or a pseudo-element) is measured from the pixels, as is the edge of form controls.

**Reviewers.** Every full run leaves a packet per state under `review/`: a screenshot, the accessibility tree, facts
about the page and the Tab order. A reviewer judges the open criteria from those and records each decision with
`decide`. An agent's decision is stored as `decidedBy: "agent"` and marked in the draft report, provisional until a
person confirms it (`--by human`). A decision survives later runs; if the audit later finds a failure on a row a
reviewer called Supports, the row goes back to Partially Supports, and the checklist lists decided rows whose evidence
names a file changed since. `report --publish` refuses while rows are open or decided by an agent only, unless
`--draft` publishes them as provisional. The cella template's `a11y-review` skill is the procedure around this loop.

**The scope.** `cella/a11y.ts` lists the template's pages and states, following steps 2 and 3 of W3C's WCAG-EM: every
page type, plus overlays such as dialogs, sheets and menus. A `{name}` in a path is filled by the resolver of that name,
which reads the API as the audit user. A state that exists only at one width carries its own browser settings, and
`forms` marks the states whose form the form probes submit. `cella/a11y.app.ts` adds the app's own.

A short script can open one state of the scope, signed in, to check a fix: `openState('<id>', { context })` from
`@cellajs/cli/a11y`, run from the app's root through `pnpm testbed -- node <script>`.

## Screenshots

`pnpm cella shoot` shoots the app's marketing screenshots on a testbed, a light and a dark file each, over the
files the app ships, and prints each file's pixel and byte size. A shot with a `mode` is written in that mode alone and
without the `-dark` suffix, for a file the app serves in one mode, such as its link preview image. Ids pick some shots (`pnpm cella shoot settings`),
`--out <dir>` writes a trial run elsewhere. An app with a `backend/scripts/seeds/showcase.json` is shot on a testbed seeded with that
showcase, which no other tool writes to, as its admin; without one the testbed holds the app's seed, and the command turns
MFA on for the shot user and a share of their members through the backend's `showcase:mfa` script where the app has it.
Nobody can sign in with those factors. A shot's `format` overrides the list's: WebP is written lossless by the system
`cwebp` encoder, checked before the testbed starts, and JPEG at quality 92 by the browser. A page that shows an earlier
shot's file, such as a composition of screenshots, gets the copy this run wrote. `cella/screenshots.ts` lists the template's shots and devices, and
`cella/screenshots.app.ts` the app's own. The cella template's `screenshots` skill is the rubric for judging them.

## Drive library

`@cellajs/cli/drive` is the browser layer the tools share, for an app's own scripts and skill drivers:
`loadPlaywright()` (the app's frontend copy), `mintSession(email)` and `signOut(session)` (a session for any seeded
user, through the backend's mint script), `newContext(browser, { session, uiStore })`, `settle(page)` and
`openPage(context, url)`. A script run through `pnpm testbed -- node <script>` mints its sessions on the testbed's
database and gets its URLs.

## Translations

`pnpm cella i18n` reads `shared/locales/<language>/<file>.json` the way the app loads them: `namespaces.json` there names the
runtime namespaces that merge several files (`c` is `common.json` with `app.json` over it), and every other file is a
namespace of its own. English holds every key, and each other language is measured against it.

| Command | What it does |
|---------|--------------|
| `pnpm cella i18n` | Per namespace and language: missing keys, keys English lacks, translations equal to English, interpolations and tags that differ from English, plural forms a language lacks or never uses, and the keys a later file of a namespace overrides. Exits 1 on a key English lacks or a mismatch; a missing translation falls back to English and only counts |
| `pnpm cella i18n unused` | The keys no code names, in this app and in the `forks` of `cella.config.ts` that exist on this machine, so a template key only an app uses stays |
| `pnpm cella i18n rename <ns:old> <ns:new>` | Renames a key and its plural forms in every language and every `'ns:old'` literal in the code, then sorts the changed locale files with the app's own Biome. A key moves to another namespace too, unless that namespace merges several files |

The code is read with the app's own TypeScript (the root `typescript` package), so a key built from a value whose
type is a union of literals, such as `` t(`c:${role}`) ``, counts as a use of each key it can build. A template whose
values are open, such as an index, is reported by its pattern (`about:why.title_*`) as unverified, and the keys it
may build are never listed as unused. A rename lists those templates and every key without its namespace passed to
`t()`, since no literal rewrite reaches them. `--json` prints any job's full report.

## Pentest

`pnpm cella pentest` is a security check to run before a release, against a copy of your own app on this machine and
nothing else. It starts a testbed on a new database, signs in as seeded users, runs three checks and removes the
database after, since the scans write rows and run into the rate limits. It refuses to start while a testbed runs.

| Check | What it does |
|-------|--------------|
| `probe` | Calls every read route scoped to a tenant, an organization or a user with the ids of an organization, once as its admin and once as an outsider with no membership in its tenant. Any answer to the outsider other than 403 or 404 is a finding |
| `nuclei` | Nuclei's templates for misconfigurations and exposures against the testbed's origin, signed in |
| `zap` | ZAP's API scan from the app's OpenAPI spec: passive rules, then an active scan capped at a few minutes, signed in |

| Command | What it does |
|---------|--------------|
| `pnpm cella pentest` | Run all three checks |
| `pnpm cella pentest --only probe` | Run only the checks named, comma-separated |
| `pnpm cella pentest report` | Print the last run's findings; `--json` prints the report as JSON |

A run fails (exit code 1) on a finding of high or critical severity, and every read the probe lets through to the
outsider is one. The scanners run as Docker images pinned by digest, pulled on first use, on the host network so
they reach the testbed by its own origin. Results stay in `.git/cella-pentest/`, out of the repository, because the
scanners' output can hold the sessions, which the run signs out at the end.

The app describes itself in `cella/pentest.ts`, synced from the template: the query that picks the seeded users, the
operations a scan must skip because they end its session or delete what it needs, the guards that mark a route as
scoped, and what fills each route's ids. `cella/pentest.app.ts` (optional, the app's own) adds the app's own skips and ids
or overrides the rest. A route whose ids nothing fills is listed as not probed, so the report says what the probe did
not reach.

## Style

`pnpm cella style` is the style check an app runs as a gate: `pnpm lint:fix` and `pnpm check` call it, and CI runs it
on every PR. It reads every file git lists, untracked ones it does not ignore included, prints each finding as
`file:line:column [rule] "term": message` and exits 1 on any. Paths limit the files the in-file rules read:
`pnpm cella style frontend/src`. It parses with the TypeScript of the app's root package and compiles classes with the
frontend's Tailwind, so the CLI ships neither.

An app lists its exceptions in `shared/config/vocabulary-allowlist.ts`, typed from `@cellajs/cli/style`:

| Key | What it exempts |
|-----|-----------------|
| `files`, `prefixes` | Paths that may carry the CLI's source-control term, such as a generated icon name list |
| `proseExclude` | Path prefixes the comment and doc rules skip, such as reference code the app keeps but does not maintain |
| `markerClasses` | Class names kept as hooks with no Tailwind utility or stylesheet rule behind them, each with its reason |

The `alignment` rule reads only what the template has. It checks the shape of every folder in `cella/alignments/`,
which `cella align` reads and an app never has. In a repo with `cella/alignments/_TEMPLATE.md` and no upgrade
manifest, it also asks a branch that changes an app-owned path template code reads from for an alignment, or for an
`Alignment: none, <reason>` line in a commit message.

| Rule | Fails on | Where |
| --- | --- | --- |
| `em-dash` | an em dash | source and config files, strings, JSON values and `.env*` files included; Markdown and MDX prose |
| `contrast-phrase` | `instead`, `rather than`, `as opposed to` | comments |
| `change-history` | `previously`, `formerly`, `used to`, `originally` | comments |
| `review-conversation` | `maybe`, `perhaps`, `we should`, `we could`, `we might`, `was considered` | comments |
| `concrete-language` | `invariant` | comments, Markdown and MDX prose |
| `load-bearing`, `authoritative` | the word the rule is named after | comments, Markdown and MDX prose, outside `infra/` and `cella/alignments/` |
| `detached-long-comment` | a comment of more than three prose lines outside a statement and not directly above a declaration; a licence header passes | source and config files |
| `code-in-link` | inline code in a link label | Markdown and MDX |
| `long-paragraph` | a prose paragraph of more than 80 words, inline code and link targets uncounted | Markdown and MDX, outside `cella/alignments/` and `cella/skills/` |
| `consequence-tail` | `, so` joining a reason and its consequence | comments, Markdown and MDX prose, on the lines the branch changed since its merge base with `origin/main`, in an app outside the lines upstream's copy of the file holds; alignments and migration notes exempt |
| `source-control-term` | the CLI's source-control term | file paths and text, outside the sync markers and the allowlisted files |
| `product-name` | `cella_*`, `Cella*`, `_cella-*`, `cellajs.com` | `backend/src`, `shared/src` and `frontend/src`, outside tests, marketing and content |
| `component-declaration` | a component declared as an arrow function, or a helper such as `memo` wrapping an unnamed render function | frontend `.tsx` sources |
| `store-selector` | a zustand store called without a selector | frontend sources |
| `route-context-selector` | `useRouteContext()` without `select` | frontend sources |
| `button-press-cancel` | `active:translate-y-0` on a `Button`, which leaves the press nudge in place | frontend sources |
| `form-no-validate` | a form react-hook-form validates without `noValidate` | frontend sources |
| `reorder-grip` | a lucide grip icon in a file that imports no `ReorderHandle` or `reorderColumn` | frontend sources outside drag previews and the editor's side menu |
| `memo-dependency-unread` | a `useMemo` or `useCallback` dependency its callback never reads | frontend sources |
| `product-cache-write` | a query-cache call that clears the refetch mark where synced product rows live; the keepers in `~/query/basic/cache-mutations` replace it | `frontend/src/query/`, product modules and range-fetch registrars |
| `tailwind-class` | a class that compiles to no CSS and that nothing selects, a variant on a plain CSS class, a stylesheet Tailwind cannot load | `frontend/src` scripts outside tests, and the Tailwind entry stylesheet |
| `text-color` | a text token with an opacity modifier outside `disabled:`, a palette gray | frontend sources; palette grays pass in the docs module and the JSON viewer theme |
| `token-contrast` | a token pair below its WCAG ratio, a theme without `--background` or `--edge-raised` | `frontend/src/styling/tailwind.css` |
| `stamp-clock` | `new Date().toISOString()` | `backend/src`, outside tests, mock builders and the two stamp helpers |
| `stamp-pair` | an object that writes `updatedAt` with `updatedBy`, or `deletedAt` with `deletedBy`, from a moment written by hand | `backend/src`, outside tests, mock builders and the two stamp helpers |
| `alignment` | an alignment folder off its shape; in the template, a changed app-owned path with no alignment or waiver | `cella/alignments/`; the branch against `origin/main` |
| `path-argument` | a path argument that matches no file | the paths `pnpm cella style` takes |

`@cellajs/cli/style` also exports the class-string helpers the template's skill scripts read with, behind
`openRepository(<repo root>)`.

## Trying a change in an app

A change to a tool reaches apps with a CLI release. To try one on an app first, run `pnpm build` here and put this
checkout in place of the app's package: `rm -rf <app>/node_modules/@cellajs/cli && ln -s "$PWD" <app>/node_modules/@cellajs/cli`.
An install in the app puts the published package back, so link again after every `pnpm install`.

## Configuration

Upgrade behavior lives in `cella.config.ts` at your monorepo root (a sensible default ships with new
apps). To deviate files or folders from the template:

- **`ignored`**: files completely excluded from upgrades (existing and new)
- **`pinned`**: full fork control, existing, modified, or deleted files are preserved

An `ignored` entry may name a path your app does not have, to keep it from arriving (a file upstream
has and your app deleted). Every run warns `ignored entry not found` only when neither your app nor
upstream has the path. Upstream is read at `settings.upstreamBranch` as last fetched; before the
first fetch, every `ignored` entry missing from your app warns.

Every run also warns about a `pinned` entry that does nothing: one inside an `ignored` path (app
modules included), one upstream no longer has or never had (the file is your app's own), and one
identical to upstream, which only drops upstream's next change to it.

## Upstream tracking

The CLI tracks upstream cella one of two ways, set via `settings.upstreamTrack`:

| Mode | Behavior | For |
|------|----------|-----|
| `release` (default) | Upgrade to the latest cella release tag. Stable and reviewable: each bump maps to a changelog. | Most forks |
| `branch` | Follow the bleeding-edge tip of `settings.upstreamBranch`. | cella maintainers, active development |

For a one-off run that ignores the configured mode, pass `--track`:

```bash
pnpm cella upgrade --track branch   # follow the tip once, without editing config
```

To upgrade to one specific upstream point, pin it with `--ref` (it wins over `--track`): a commit sha,
a release tag or an upstream branch name, resolved on the upstream remote (`main` is upstream's
`main`, not yours). The ref must be on `settings.upstreamBranch` or in an upstream release; a
release tag upgrades as that release, anything else is recorded like branch tracking.

```bash
pnpm cella upgrade --ref 4f7d87c      # upgrade up to this upstream commit
```

A run never upgrades to a point behind the last upgrade: when an earlier `--ref` or `--track branch` run
went past the latest release, release tracking ends with a `nothing to upgrade` message until a newer
release exists, instead of reverting what the app already has. A `--ref` behind the last upgrade is
refused. Either way the run changes nothing and leaves you on the branch you started from.

## Upgrade workflow

`pnpm cella upgrade` never commits to `main` directly. 

```
main ──▶ cella/upgrade/<stamp> ──(3-way merge)──▶ PR ──(squash)──▶ main
```

It runs a real git 3-way merge. `upgrade` is **idempotent and staged**: each run advances the upgrade
one stage, and the run that commits never ships: the pause on the committed branch is where
drift triage (`pnpm cella analyze` diffs committed HEAD) and follow-up commits happen.

1. **First run** cuts the branch and merges. A clean merge is committed right away: dependencies
   are reconciled (`pnpm install` + `pnpm check`), everything is staged, and the delta is
   committed; then the run stops on the branch. A conflicted merge stops earlier so you can
   resolve in your IDE (`git add` the resolved files) and re-run to commit.
2. **Final re-run `pnpm cella upgrade`** on the committed branch ships it: pushes to `origin`,
   opens a PR into `main` (via `gh`) titled like the upgrade commit, even with follow-up commits on
   top, and switches you back to `main`.

Before the merge starts, a first run checks that it can go ahead, and stops without changing
anything when it cannot: the temporary branch is removed again and you are back on the branch you
started from. It stops when upstream needs a newer `@cellajs/cli` than the one running, and when
upstream changed its own CLI config in ways yours does not follow (see
[Upstream changes that never merge](#upstream-changes-that-never-merge)).

`upgrade` also runs from a linked git worktree while another worktree has `main` checked out: it
never switches to `main`. It compares `main` with `origin/main` by ref and cuts the upgrade branch
from `main`; when `main` is behind and checked out elsewhere, it cuts from `origin/main` instead
and leaves `main` as it is. After shipping, the worktree detaches at `main` instead of switching
to it. When HEAD builds on that start point, as a branch holding a CLI bump or the renames an
alignment asks for does, the upgrade branch is cut from HEAD, and those commits ride in the
upgrade PR.

When the commit stage runs, the in-progress merge state (`MERGE_HEAD`) is discarded, so the staged delta
collapses into a **single-parent commit** (`chore: upgrade cella to <sha>`). This keeps the PR
to one clean commit with the incremental diff; a two-parent merge commit would instead list the
upstream branch's entire history, because the fork doesn't share pushed ancestry with upstream
and the local `git replace` graft that makes merges incremental is never pushed. Ancestry lives
in `refs/cella/last-upgrade` (and the committed `cella.manifest.json` for fresh clones), so
`git merge-base` keeps working across throwaway branches; each is safe to delete once its PR
lands. The three-segment name can't collide with git's ref namespacing.

If conflicts remain when you re-run, `upgrade` lists them and stops (never starting a second cycle
mid-merge). If `pnpm check`, the push, or `gh` fails, it degrades gracefully, reporting the
issue and printing the remaining manual steps:

```bash
git push -u origin cella/upgrade/<stamp>
gh pr create --base main --head cella/upgrade/<stamp> --fill
```

## Analyze output

`pnpm cella analyze` prints its file sections in the order they need you: what merges on its own
first (`behind`, `diverged`), then pinned files, drifted files, and the upstream changes the upgrade
leaves out (`protected but behind upstream`). The summary and `next steps` close the run, so the
last lines are the ones to act on. A file row is its path, linked per `fileLinkMode`, with a count
and a short age (`3h`, `2d`, `3mo`) in columns.

Large groups collapse: more than 15 behind files become one row per folder, more than 8 pinned files
keep the ones missing 10 or more upstream lines, and five or more protected files of one kind under
one override entry become one row (`backend/drizzle/ · 42 × snapshot.json`). `--all` lists every
path.

Analyze and upgrade both end with `next steps`, numbered in the order you take them: the review page,
the command to run next, and the alignments the upgrade brings or that are still open.

```
next steps
────────────────────────────────────────────────────────────

  1 review   file:///Users/you/app/.git/cella-diff/analyze-review.html
             22 diffs in 3 sections · 42 listed without a diff
  2 upgrade  pnpm cella upgrade
             commits on a fresh branch, a rerun opens the PR · 36 update, 2 merge
  3 align    1 alignment arrives with this upgrade
             ○ Migration notes become alignments · manual · not breaking
             after the upgrade: pnpm cella align
```

Without a terminal (piped, or read by an agent) each alignment row also gets its id, for
`pnpm cella align --show <id>`.

## Alignments

Upstream ships an alignment for every change that app code has to follow, in
`cella/alignments/<id>/`: a README (frontmatter, title, summary, then the steps) and sometimes a
codemod. Alignments stay upstream. The upgrade never brings that folder into the app and removes a
copy it finds (also of `cella/migrations/`, the migration notes upstream deleted when it started
the alignments); `align` reads them from the upstream commit the app last upgraded to, which the upgrade
already fetched.

The frontmatter says what the change asks of the app: `breaking`, `clientCacheBump`,
`caughtBy` (`compiler`, `tests` or `nothing`: what catches app code the change leaves behind),
`generate` (the change needs `pnpm generate`), `grep` (terms app code may still use) and, beside a
codemod, its `roots`. A `grep` term that starts and ends with a letter or digit matches as
a whole word; any other term, such as `.results`, matches anywhere in a line.

The app keeps one small record, `cella/cella.alignments.json`, listing the alignments it has not
handled yet. The upgrade adds the ones that arrive with it, `align --mark` removes them, and the file
is deleted once the list is empty. No file means nothing is pending, so a new app starts without
one.

Alignments are information, never a gate. `analyze` and each upgrade run list them under
[`next steps`](#analyze-output): by title, with their kind, at most five. In `analyze` the ones in
the upgrade range *arrive with this upgrade*; they become open once the upgrade lands, which is when
`pnpm cella align` lists them. `pnpm cella align` itself ends with one line:

```
alignments: 94 of 97 handled · 3 open: pnpm cella align
```

The upgrade PR lists the open alignments with links. Handle them in the upgrade PR or later; they
stay listed until marked.

```bash
pnpm cella align                    # open alignments, with summary and links
pnpm cella align --show <id>        # one alignment's README and what git tells about it
pnpm cella align --run <id>         # run its codemod, report only
pnpm cella align --run <id> -- rewrite frontend/src   # run it with your own arguments
pnpm cella align --extract <id>     # its folder under node_modules/.cache/cella/alignments/<id>/
pnpm cella align --mark <id> [...]  # record alignments as handled
```

Next to its README, each alignment shows what git can tell about it: the upstream commit and PR
that added it, the other alignments of that commit, the files of that commit the app pins, ignores
or changed, and the lines of app code that hold one of its `grep` terms. Only files that differ
from the upstream commit of the last upgrade count, so a template file the app never touched is
never a hit. Two or more open alignments with `generate` get one line: work their code steps first, then
generate once. `--show` reads an alignment the last upgrade does not have yet from the fetched
upstream branch, so it works before the upgrade that brings it.

`--run` extracts the alignment and runs its codemod with `tsx` from your app root. Everything after
`--` goes to the codemod as given; without it the codemod gets `inventory` and the alignment's
`roots`, the report-only run.

A codemod's roots cover template-owned files too, and a file that is identical to upstream already
is the way upstream wants it: upstream may have changed it after writing the codemod, so a rewrite
there only creates drift. Before the codemod starts, `--run` notes which files are byte-identical
to the upstream commit of the last upgrade (`upstream.commit` in `cella/cella.manifest.json`,
during a staged upgrade the incoming commit). After the run, each of those files the codemod changed gets its
upstream content back, and the run prints how many it restored. Files your app changed keep the
codemod's rewrite. The codemod's own report still counts the restored files, in a report-only run
too. A codemod run by hand from the `--extract` folder has no such protection.

## Merge rules

For each file, `upgrade` compares fork and upstream **content** (blob comparison) and resolves it
per the table below. Unconfigured files converge on upstream; `ignored` and `pinned` let you opt
out:

| Scenario | `ignored` | `pinned` | Default |
|----------|:---------:|:--------:|:-------:|
| Content identical | ✅ Keep | ✅ Keep | ✅ Keep |
| Content differs | ⏭️ Skip | ✅ Keep yours | ⬇️ Take upstream |
| New upstream file | ⏭️ Skip | ✅ Keep (respect deletion) | ➕ Add file |
| Deleted in upstream | ✅ Keep | ✅ Keep | 🗑️ Delete |
| Only in your app | ✅ Keep | ✅ Keep | ✅ Keep |

**Choosing an override:** `ignored` = file never merges and is fully hidden (app-specific docs,
assets, config you own). `pinned` = your version always wins but stays visible (files you
customize). Unconfigured = merges automatically. Run `pnpm cella analyze` first to preview.

## Status indicators

During analysis and upgrade, files are displayed with status indicators:

| Symbol | Label | Meaning | Action |
|:------:|-------|---------|--------|
| ◇ | `managed` | Package/config file changed | Handled separately by cella |
| ⨂ | `ignored` | Protected by ignored config | Excluded from upgrades |
| ✓ | `identical` | Fork matches upstream | No action needed |
| ↑ | `ahead` | Fork changed (pinned), upstream did not | Protected, keeping fork |
| ! | `drifted` | Fork changed, not protected | At risk, consider pinning |
| ↓ | `behind` | Upstream has changes | Will update from upstream |
| ⇅ | `diverged` | Both sides changed | Will merge from upstream |
| ⨀ | `pinned` | Both changed, fork wins | Protected, keeping fork: review, see below |
| + | `local` | Only in fork, never in upstream | No action needed |

### Protected but behind upstream

A pinned or ignored file wins whole-file: when upstream also changed it since the last upgrade,
upstream's hunks are dropped, not merged. That is easy to miss (a pinned stylesheet quietly
missing new upstream utilities that merged components rely on), so both commands call it out:

- `analyze` lists them in a `⚠ protected but behind upstream` section (pinned files as ⨀,
  ignored as ⨂) with the number of lines upstream changed, together with the ignored files only
  upstream changed (tagged `new` or `deleted`, see below). New files come first, then the most
  changed; generated output the fork regenerates itself (`sdk/gen`, `*.gen.*` files) is left out.
  `--list`/`--json` include them in `--scope all` and `--scope protected` (`--json` adds
  `upstreamChanged` and `upstreamChangedLines`).
- `upgrade` prints the same list at the end of its summary, right when the drop happens.

```
⚠ 3 protected files kept the fork version, dropping upstream changes:
  ⨀ frontend/src/styling/tailwind.css · 21 lines changed upstream
  ⨂ shared/config/default.ts · 4 lines changed upstream
  ⨂ shared/config/staging.ts · 2 lines changed upstream
  pinned/ignored files where upstream also changed since the last upgrade; the fork side wins on conflict, so review what upstream changed and adopt what you need.
```

The [review page](#review-page) shows what upstream changed in each of them since the last upgrade.
The check is relative to the last upgrade: a drop that happened in an earlier upgrade only shows
up as plain `ahead` afterwards. For that case the `↑ protected in fork` section counts the
`upstream lines absent` from each pinned file (lines upstream has that the fork lacks, compared at
the tips, `--json`: `upstreamLinesAbsent`). That is upstream content the fork never received,
deliberately or not: the review page shows the difference, so you can decide. Ignored files are
not annotated.

To pull upstream into every pinned file at once, run `upgrade --unpinned`: pins are lifted for that
run (managed files stay pinned) and the merge uses the full upstream history, so changes earlier
upgrades dropped come back too. Review the staged merge in your editor and keep what you want;
`analyze --unpinned` previews it.

### Upstream changes that never merge

Two more kinds of upstream change never reach the fork on their own. `analyze` lists the first in
`protected but behind upstream` and prints the second after its file sections; `upgrade` prints both
after its merge summary:

- **Ignored paths changed upstream.** Upstream changed, added or deleted a file under an `ignored`
  entry (app-owned module folders included) and the fork left it untouched. No conflict marks it,
  so this is where new config keys and version bumps under `shared/config` show up. In `upgrade`
  each `ignored` entry gets one line with a file count, and the [review page](#review-page) shows
  the diffs. Files
  both sides changed stay in the section above, and generated output the fork regenerates itself
  (`sdk/gen`, `*.gen.*` files) is left out. `--list`/`--json` include these
  files in `--scope all` and `--scope protected` (`--json`: `upstreamOnly`).
- **Upstream CLI config changes.** `cella/cella.config.ts` never merges, so entries upstream adds to
  its own `overrides.pinned` or `overrides.ignored`, and keys it adds to `settings.packageJsonKeys`
  (the template your config started from), never arrive. The report names each entry upstream added
  that your config lacks (`+`) and each entry upstream dropped that your config still has (`−`). It
  reads upstream's config without running it and never edits yours. `--json` puts the lists on the
  `cella/cella.config.ts` entry (`upstreamOverrides`).

```
⚠ ignored paths changed upstream · 1 file under 1 entry
  ⨂ frontend/src/modules/marketing · 1 file
  the fork left these untouched and ignored paths never merge: review and adopt what you need.

⚠ upstream changed its CLI config · 2 entries to review
  + pinned: backend/src/bundle-config.ts
  + packageJsonKeys: exports
  cella/cella.config.ts never merges: add or drop these by hand where they fit your app.
```

`analyze` only reports these. `upgrade` checks the CLI config before a new merge and stops when it
finds entries: the merge runs on your config, so with a list that is behind, a path upstream now
ignores or pins would arrive as an ordinary merged file (upstream renamed an ignored folder, your
list still names the old one). Nothing has changed at that point. Add or drop the entries that fit
your app in `cella/cella.config.ts`, commit and rerun, or pass `--keep-config` to merge with your
config as it stands; the report then follows the merge summary as before. The rerun that commits an
already staged merge never stops for this.

```bash
pnpm cella upgrade --keep-config   # merge although upstream changed its CLI config
```

### Review page

The terminal lists files; the review page shows their diffs, side by side and highlighted, on one
page in your browser under the same section titles. `analyze` and `upgrade` write it whenever a list
has files, and list it first under [`next steps`](#analyze-output):

```
  1 review   file:///Users/you/app/.git/cella-diff/upgrade-review.html
             3 diffs of upstream changes that did not arrive · opened in the browser
```

| Section | `analyze` | `upgrade` | The diff shows |
| --- | --- | --- | --- |
| protected but behind upstream (upgrade: protected files kept the fork version) | ✓ | ✓ | what upstream changed since the last upgrade |
| ignored paths changed upstream (analyze: under protected but behind upstream) | ✓ | ✓ | what upstream changed since the last upgrade |
| pinned files that match the previous upstream | ✓ | ✓ | what upstream changed since the last upgrade |
| protected in fork, upstream lines absent | ✓ | | the fork against upstream, both as they are now |
| drifted from upstream | ✓ | | what the fork changed since the last upgrade |

`upgrade` opens the page in your browser when it runs in a terminal: the files on it are upstream
changes the merge did not bring in, and the committed upgrade branch is where you adopt them.
`analyze` only lists the page, since you run it often and pinned files keep their absent lines.
The page lives in the git dir, so it never shows up in `git status`, and each run overwrites it. It
renders at most 50 diffs and 15,000 diff lines, and a single diff over 2,000 lines is listed
instead (a rendered line costs about 0.6 KB of page). Sections take turns, one file each, so every
section gets diffs before one fills the page. The rest, and files without a text diff, are listed
by path.

## Package.json merge

`packageJsonKeys` controls which package.json sections merge from upstream:

```typescript
packageJsonKeys: ['dependencies', 'devDependencies', 'scripts']
```

**Supported keys:** `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, `scripts`, `engines`, `packageManager`, `overrides`, `exports`, `pnpm`

Each section merges three-way against the merge-base package.json (upstream as of your last
upgrade). An entry your fork never touched follows upstream: it is **added**, **updated** (a rewritten
script, a changed range) or **removed** when upstream dropped it. An entry your fork added or
changed stays as it is; only a strictly higher upstream version still bumps it, and never for
`scripts`. An entry your fork removed is not re-added. A dependency or script upstream dropped
stays while your own code still uses it: files that differ from upstream and scripts your fork
added or changed are searched for an import of the package, a run of its CLI, or a package manager
command that runs the script. The upgrade lists every change and warns about each entry it kept this
way, so you can remove it once your code no longer needs it. `exports` are add-only: an entry your fork
already defines is never rewritten, and `exports` only merges when both sides are subpath maps
(`{ ".": …, "./config": … }`). A workspace upstream added since your last upgrade arrives with its
package.json copied verbatim. A merged section is sorted alphabetically, except `scripts`: they
keep upstream's order, and a script only your fork has stays after the one it follows.

`type` always merges, whatever `packageJsonKeys` lists: it follows upstream where your fork kept the
previous value, and a package.json without `type` gets upstream's. Set it yourself (for example
`"commonjs"`) to keep your own.

## Audit

`pnpm cella audit` works in two layers, in this order:

1. **Updates.** It lists the outdated packages and runtime pins in one table and asks once which to
   update. Rows with a high or critical advisory start ticked; submitting with nothing ticked skips
   this layer. Above the prompt it prints what `pnpm audit` reports right now, including packages
   that have no row, so a run you cancel has shown them too.
2. **Security.** It audits the workspace as the picked updates leave it and brings three settings
   in `pnpm-workspace.yaml` in line with that audit.

Nothing is written until the end: the updates and the security settings land together, with a
single `pnpm install`. Cancelling any prompt leaves the workspace as it was.

### Runtime pins

`pnpm audit` only sees the lockfile, so the audit also checks the runtimes the workspace pins to an
exact version, against their own release feeds:

| Pin | Feed | Dot |
|-----|------|-----|
| root `engines.node` | nodejs.org release index | red when a newer release in the line is a security release |
| root `packageManager` (pnpm) | npm registry and its advisory database | red when the newer version fixes an advisory on yours |
| `FROM image:2.8-suffix` in tracked Dockerfiles | Docker Hub tags | yellow when your tag has had no push for 6 months while a newer one has |

A pin moves within its major, to the newest version older than `minimumReleaseAge`. A Node bump
waits until Docker Hub has the `node:<version><suffix>` images the Dockerfiles build from, and the
audit prints what is left to do on your machine: switching its Node, and building each changed image.

### This machine

The pins say what the workspace should run; the tools on your machine can still miss security
fixes. Below the table the audit shows, for each one, what it misses:

| Tool | Which one | Feed |
|------|-----------|------|
| Node | the one running the audit, which also runs the workspace | nodejs.org release index |
| pnpm | the one your terminal starts, before it switches to `packageManager` | npm advisory database |
| gh | the one on your PATH | OSV |

A tool that misses a fix gets a dot and the command to fix it, for the way it was installed (Volta,
Homebrew, or pnpm's own `self-update`), naming the newest version that has every fix and is older
than `minimumReleaseAge`. The audit does not change these tools itself.

### Holding a package back

To keep a package off the update list, use pnpm's own setting, with the reason as a comment.
`pnpm outdated` skips it, so the audit does too, and `pnpm audit` still checks it:

```yaml
updateConfig:
  ignoreDependencies:
    - typescript # 7 drops the JS compiler API that SDK codegen needs
```

The security layer treats its overrides as output, not as configuration. Every run it drops them,
resolves the workspace without them in a temporary copy, and puts back only the ones a current
advisory still needs. An override whose package now resolves to a fixed version, because you
updated a parent or the parent widened its range, is gone after the next run. The workspace
changes once, at the end, and only when the outcome differs from what is there.

| Setting | What the audit owns | What it leaves alone |
|---------|---------------------|----------------------|
| `overrides` | keys with a version selector: `pkg@<1.2.3` | keys without one (`pkg`) and parent-scoped keys (`parent>pkg`) |
| `minimumReleaseAgeExclude` | `pkg@1.2.3` entries, removed once that version is older than `minimumReleaseAge` | name-only entries |
| `auditConfig.ignoreGhsas` | every entry, removed when the advisory no longer applies or a fix arrives | |

To keep an override whatever the audit finds, write it without a version selector.

For each advisory the audit looks up the published versions itself; it does not trust the patched
version an advisory claims. Most outcomes need no answer from you:

- **A fix that fits.** The audit writes an override. When the fix lies inside the range the
  parents ask for, the lockfile holds the fixed version on its own, and the following run drops
  the override.
- **A breaking fix** (another major, or another minor below 1.0), or a fix for a package you
  depend on directly: you choose between leaving it open, applying the override and ignoring the
  advisory. An override that was in place before the run is applied again without asking.
- **A fix younger than `minimumReleaseAge`**: you choose between waiting and installing it now
  with an exclude.
- **No fix published**: you are asked whether to ignore the advisory until one is.

`--list` prints the same report without prompts and writes nothing.

## Adopt from forks

Upstream can pull modifications from local forks and selectively adopt them.

To use it, list your local forks in `cella.config.ts`:

```typescript
forks: [
  { name: 'raak', localPath: '../raak', pullBranch: 'main' },
],
```

### Pulling contributions

Run `pnpm cella adopt` (or pick **adopt** from the menu). Select a fork; cella
fetches its `pullBranch` and builds a clean local `contrib/<fork>` branch with only that fork's
contributed files. Press `d` on a file to open its diff in your browser. Accepted files are
checked out from the contrib branch and staged for review.

## Stats of a branch

`pnpm cella stats` counts the whole repository. With `--since <ref>` it counts what the current
branch changed since it left that ref, by kind of file, which is what a pull request into the ref
shows. Only committed work counts.

```bash
pnpm cella stats --since origin/main        # tables in the terminal, -V lists every file
pnpm cella stats --since origin/main --md   # a markdown table on stdout, for a PR description
```

```
  files    added  removed      net
      8     +438       -6     +432  tests
     14     +229     -109     +120  source
      1      +44        0      +44  docs
      2      +11       -6       +5  json
     25     +722     -121     +601  total

  source lines by content
            +152      -87      +65  code
             +49       -9      +40  comments
             +28      -13      +15  blank
```

| Kind | Files it holds |
|------|----------------|
| source | Code and styles that are none of the kinds below |
| tests | `*.test.*`, `*.spec.*` and anything under a `tests/`, `test/` or `__tests__/` folder |
| stories | `*.stories.*` |
| generated | `*.gen.*`, `gen/` folders, `drizzle/`, `*.d.ts` and lock files |
| json | `*.json` and `*.jsonc` that are not generated: config and translations |
| docs | `*.md` and `*.mdx` |
| other | Everything else, such as workflows and Dockerfiles |

Source lines are also split by what they hold. A diff shows changed lines only, so a comment is
recognized by how the line starts (`//`, `/*`, `*`, `{/*`): a line of a template literal that starts
that way counts as a comment too.
