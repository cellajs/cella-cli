# @cellajs/cli

The command line of apps built from the [cella template](https://github.com/cellajs/cella): a testbed and the tools that
run on it (load tests, an accessibility audit, a security scan, the marketing screenshots), the style check, and
upgrades from upstream cella that keep your customizations.

## Usage

From the app's root, run `pnpm cella` for a menu of commands, or name one:

```bash
pnpm testbed
pnpm cella bench
pnpm cella a11y
pnpm cella analyze
pnpm cella upgrade
pnpm cella audit
```

The CLI runs on macOS and Linux with Node 26 or later, and calls `git` and `pnpm` from the PATH. Every command needs a
git repository except `audit`, which runs in any folder. The upstream commands, `style` and `i18n unused` read
`cella/cella.config.ts`; the other commands run without it.

## Commands

`pnpm cella <command> --help` lists a command's jobs and options.

| Group | Command | What it does |
|-------|---------|--------------|
| Develop | `testbed` | A throwaway copy of the app on its own seeded database and ports, beside `pnpm dev` |
| | `bench` | Load-test the running app and check what the stack did with the load |
| | `a11y` | Audit the app against WCAG 2.2 AA on a testbed and keep the conformance ledger |
| | `shoot` | Shoot the marketing screenshots on a testbed |
| | `i18n` | Translation status, unused keys and renames across the locale files and the code |
| | `stats` | Count files by kind, in the repository or in what a branch changed |
| Security | `audit` | Outdated packages, runtime pins and the security overrides a fresh audit asks for; `audit fix` updates them |
| | `pentest` | Scan a throwaway testbed: a cross-tenant access probe, then Nuclei and ZAP |
| Upstream | `analyze` | A dry run of the next upgrade |
| | `upgrade` | Merge upstream onto a fresh branch and open a squash-merge PR |
| | `align` | The upstream alignments this app has not handled yet: list, read, run their codemods, record them |
| | `adopt` | Pull and adopt changes from local forks |
| Gate | `style` | The style check: terminology, docs, comments and frontend code |

The menu leaves out `testbed`, which `pnpm testbed` runs, and `style`, which scripts and CI run. It shows `adopt` only
when `cella.config.ts` lists `forks`.

## Compatibility

Across 1.x releases these stay as they are, and a change to one waits for 2.0:

- the command names and what each does, and their flags
- the keys of `cella/cella.config.ts` and of the adapter files in `cella/`
- the package's subpaths (`config`, `bench`, `style`, `drive`, `a11y`, `screenshots`, `pentest`) and the names they
  export
- the `--json` payloads
- the exit codes
- the files the upgrade keeps in the app, `cella/cella.manifest.json` and `cella/cella.alignments.json`, and the ref
  `refs/cella/last-upgrade`

Every command exits 0 when its run is done or a plain rerun advances it, 1 when a check failed or a person must act
before it can go on, and 2 on a usage or runtime error. A run stopped by ctrl-c exits 130, and one stopped by SIGTERM
143, after its cleanup ran.

Until 1.0 two older shapes still load, each with a warning that says what to move: a `cella.config.ts` in the 0.7 shape,
with `settings` and `overrides` blocks, and the style exceptions in `shared/config/vocabulary-allowlist.ts`.

## Testbed

`pnpm testbed` starts a copy of the app on a database of its own and on ports beside the ones `pnpm dev` uses: the
backend, the workers, the relay and a built frontend. A new database is seeded once and kept, and every start migrates
it: a branch with migrations works too. The testbed holds until ctrl-c, which stops its servers and its database
container.

`pnpm testbed -- <command>` runs a command against a testbed: the one this checkout holds, or one started for the
command and stopped after. The command gets the testbed's ports (`DEV_PORT_OFFSET`) and database URLs in its
environment. `pnpm testbed stop` stops a testbed, or the servers one left behind after a crash.

One testbed runs per app on a machine, since every checkout of the app shares its database: a second start, from another
worktree too, says which checkout holds it. A start that fails prints the end of the servers' log, `testbed.log` in
`.git/cella-testbed/`. The testbed needs Docker and a `db_testbed` service in the app's `backend/compose.yaml`.

The database holds either the app's seed or its showcase, the curated `backend/scripts/seeds/showcase.json` that the
screenshots shoot. A start that asks for the other one seeds a new database, and so does every showcase start, since the
showcase's times are relative to its seed. A running testbed serves only commands that want what it holds.

## Tools and adapters

A tool's engine ships in this package, and what is app-specific sits in the app's `cella/` folder as adapters: a base
`cella/<tool>.ts` that each upgrade brings from the template, and an optional `cella/<tool>.app.ts` that no upgrade
touches. The app file holds only the app's delta: its lists join the base's, `remove` drops base entries, and an entry
with a base id replaces that entry. Without it the base runs alone.

Each file default-exports its tool's define helper, such as `defineA11yBase` or `defineA11yApp` from
`@cellajs/cli/a11y`, which types it. Both are checked at load: an adapter that does not fit the installed CLI fails in
seconds, naming the key. Adapters import the app's SDK and run under the app's own `tsx`.

The tools that open the app's pages, `a11y` and `shoot`, sign in as a seeded user with a minted session and sign it out
when they end, on ctrl-c too. Both of their adapter files may set `prepare` (steps before the first page),
`placeholders` (the value of each `{name}` in a path, read as the signed-in user) and `suppress` (alerts and hints
marked seen before the first page).

Heavy runtimes come from the app: Playwright from `frontend`, with its Chromium installed once through
`pnpm --filter frontend exec playwright install chromium`. Results stay in the git directory, out of `git status`:
`.git/cella-<tool>/` in the main checkout and the worktree's own in a linked one.

## Bench

`pnpm cella bench` load-tests the app with the scenarios in `backend/bench/scenarios/`. New virtual users arrive on
schedule whether or not earlier ones are done, a live line shows what the last interval did, and the summary ends in
checks: the responses the stack rejected, failed users, latency thresholds, the scenario's own counters, and the app's
checks of what the stack recorded. A passing full run is saved as the scenario's baseline, and the next run at the
same emulated round trip (`--rtt`) compares with it.

A run measures the stack this checkout runs with `pnpm dev`, or a [testbed](#testbed) with `--isolated`, and one run at
a time holds it. Baselines, logs and locks live in `cella-bench/` in the git directory every worktree shares.

The app's side is `backend/bench/run.ts`, run with the backend's `tsx` so it imports backend modules: it calls
`runBench` from `@cellajs/cli/bench` with the app's preflight, seed and checks around each scenario. A scenario is a
module that default-exports `defineScenario({...})` from the same import; counter and histogram names are typed, so a
misspelled one fails the typecheck.

## a11y

`pnpm cella a11y` audits the app against WCAG 2.2 Level A and AA and fills the conformance ledger,
`cella/a11y-ledger.json`. On a testbed, signed in as the seeded admin (`ADMIN_EMAIL` of `.env`), it visits every state
of `cella/a11y.ts` in light mode for every check and in dark mode for contrast: an axe scan, browser checks that axe
cannot do, and a review of the code for the rest.

Only a complete run replaces the ledger. A run of some states (`--states`), or one with a failed visit (a page that
redirects, a check that cannot run), writes `ledger-partial.json` in the results folder, and a failed visit fails the
run. It leaves a screenshot and a JSON file under `review/`: what the page showed, its console errors and the steps that
ran before.

**The ledger.** One row per criterion, committed, with its status, the remarks for the report, the evidence and the
checks still open. It carries the product's name (the root package name), and another product never reads it: a new app
starts its own with its first full run. Raw findings for fixing, the draft VPAT and the checklist stay in the results
folder.

**How a row is decided.** Each criterion names its checks: axe, a browser probe, a code check or a manual one. Any
failure makes the row Partially Supports. A row becomes Supports or Not Applicable only when all its checks ran and none
of them is manual; everything else stays open until a reviewer decides it.

**Reviewers.** Every full run leaves a packet per state under `review/`: a screenshot, the accessibility tree, facts
about the page and the Tab order. A reviewer judges the open criteria from those and records each decision with
`a11y decide`; an agent's decision stays provisional until a person confirms it. A later failure on a row a reviewer
called Supports puts it back to Partially Supports, and the checklist lists decided rows whose evidence names a file
changed since.

**The report.** `a11y report` renders the ledger as a draft VPAT and the checklist for the manual pass. With `--publish`
it puts the report where the app serves it and prints what the statement needs; it refuses while rows are open or
decided by an agent only, unless `--draft` publishes them as provisional. The cella template's `a11y-review` skill is
the procedure around this loop.

**The states.** `cella/a11y.ts` lists the template's pages and states, following steps 2 and 3 of W3C's WCAG-EM: every
page type, plus overlays such as dialogs, sheets and menus. A state that exists only at one width carries its own
browser settings, and `forms` marks the states whose form the form probes submit. `cella/a11y.app.ts` adds the app's
own.

A short script can open one state, signed in, to check a fix: `openState('<id>')` from `@cellajs/cli/a11y` returns its
page, its context and `close`. Run the script from the app's root through `pnpm testbed -- node <script>`.

## Screenshots

`pnpm cella shoot` shoots the app's marketing screenshots on a testbed, a light and a dark file each, over the files the
app ships, and prints each file's pixel and byte size. Ids pick some shots (`pnpm cella shoot settings`), and
`--out <dir>` writes a trial run elsewhere.

An app with a `backend/scripts/seeds/showcase.json` is shot on a testbed that holds the showcase, as its admin; without
one the testbed holds the app's seed. A page that shows an earlier shot's file, such as a composition of screenshots,
gets the copy this run wrote.

A shot with a `mode` is written in that mode alone and without the `-dark` suffix, for a file the app serves in one
mode, such as its link preview image. A shot's `format` overrides the list's: WebP is written lossless by the system
`cwebp` encoder, which the run checks before the testbed starts, and JPEG by the browser.

`cella/screenshots.ts` lists the template's shots and devices, and `cella/screenshots.app.ts` the app's own. The cella
template's `screenshots` skill is the rubric for judging them.

## Drive library

`@cellajs/cli/drive` is the browser layer the tools share, for an app's own scripts and skill drivers.
`loadPlaywright()` loads the app's frontend copy of Playwright. `mintSession(email)` signs in any seeded user through
the backend's mint script and returns a `Session`: the app's URLs, the cookie a browser context adds and the `header` a
request sends. `signOut(session)` ends it. A script run through `pnpm testbed -- node <script>` mints its sessions on
the testbed's database and gets its URLs.

## Translations

`pnpm cella i18n` reads `shared/locales/<language>/<file>.json` the way the app loads them: `namespaces.json` there
names the runtime namespaces that merge several files (`c` is `common.json` with `app.json` over it), and every other
file is a namespace of its own. English holds every key, and each other language is measured against it.

- `pnpm cella i18n` reports per namespace and language: missing keys, keys English lacks, translations equal to English,
  interpolations and tags that differ from English, plural forms a language lacks or never uses, and the keys a later
  file of a namespace overrides. It exits 1 on a key English lacks or a mismatch; a missing translation falls back to
  English and only counts.
- `pnpm cella i18n unused` lists the keys no code names, in this app and in the `forks` of `cella.config.ts` that exist
  on this machine. A template key that only an app uses stays.
- `pnpm cella i18n rename <ns:old> <ns:new>` renames a key and its plural forms in every language and every `'ns:old'`
  literal in the code, then sorts the changed locale files with the app's own Biome. A key moves to another namespace
  too, unless that namespace merges several files.

A key built from a value whose type is a union of literals, such as `` t(`c:${role}`) ``, counts as a use of each key it
can build. A template whose values are open, such as an index, is reported by its pattern (`about:why.title_*`) as
unverified, and the keys it may build are never listed as unused. A rename lists those templates and every key passed to
`t()` without its namespace, which no literal rewrite reaches.

## Pentest

`pnpm cella pentest` is a security check to run before a release, against a copy of your own app on this machine and
nothing else. It starts a testbed on a new database, signs in as seeded users, runs three checks and removes the
database after, since the scans write rows and run into the rate limits. It refuses to start while a testbed runs.

| Check | What it does |
|-------|--------------|
| `probe` | Calls every read route scoped to a tenant, an organization or a user with the ids of an organization, once as its admin and once as an outsider with no membership in its tenant. Any answer to the outsider other than 403 or 404 is a finding |
| `nuclei` | Nuclei's templates for misconfigurations and exposures against the testbed's origin, signed in |
| `zap` | ZAP's API scan from the app's OpenAPI spec: passive rules, then a capped active scan, signed in |

A run fails on a finding of high or critical severity, and every read the probe lets through to the outsider is one. A
scanner that failed or timed out fails it too. `pnpm cella pentest report` prints the last run's findings.

The scanners run as Docker images pinned by digest, on the host network, where they reach the testbed by its own origin.
Results stay in `.git/cella-pentest/`, out of the repository, because the scanners' output can hold the sessions, which
the run signs out at the end.

`cella/pentest.ts` describes the app: the query that picks the seeded users, the operations a scan must skip because
they end its session or delete what it needs, the guards that mark a route as scoped, and what fills each route's ids.
`cella/pentest.app.ts` adds the app's own skips, guards and ids, and its `remove` drops base entries the app does not
have. A route whose ids nothing fills is listed as not probed: the report says what the probe did not reach.

## Style

`pnpm cella style` is the style check an app runs as a gate: `pnpm lint:fix` and `pnpm check` call it, and CI runs it on
every PR. It reads every file git lists, untracked ones it does not ignore included, prints each finding to stdout as
`file:line:column [rule] "term": message` and exits 1 on any. Paths limit the files the in-file rules read:
`pnpm cella style frontend/src`. It compiles classes with the frontend's own Tailwind.

An app lists its exceptions in `shared/config/style-exceptions.ts`. They join the exceptions of the template's own code,
and an id that names no rule fails the run:

```typescript
import type { StyleExceptions } from '@cellajs/cli/style';

export const styleExceptions: StyleExceptions = {
  // The files and folders each rule skips, by rule id
  exempt: { 'long-paragraph': ['docs/reference/'] },
  // Class names kept as hooks with no Tailwind utility or stylesheet rule behind them
  markerClasses: ['is-dragging'],
};
```

Two rules read only what the template has. `alignment` checks the shape of every folder in `cella/alignments/`, which
`cella align` reads and an app never has. In a repository with `cella/alignments/_TEMPLATE.md` and no upgrade manifest,
`owed-alignment` asks a branch that changes an app-owned path template code reads from for an alignment, or for an
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
| `source-control-term` | the CLI's source-control term | file paths and text, outside the `fork:` markers and the exempt files |
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
| `text-color` | a text token with an opacity modifier outside `disabled:`, a palette gray | frontend sources; palette grays pass in the syntax colors the template exempts |
| `token-contrast` | a token pair below its WCAG ratio, a theme without `--background` or `--edge-raised` | `frontend/src/styling/tailwind.css` |
| `stamp-clock` | `new Date().toISOString()` | `backend/src`, outside tests, mock builders and the two stamp helpers |
| `stamp-pair` | an object that writes `updatedAt` with `updatedBy`, or `deletedAt` with `deletedBy`, from a moment written by hand | `backend/src`, outside tests, mock builders and the two stamp helpers |
| `alignment` | an alignment folder off its shape | `cella/alignments/` |
| `owed-alignment` | a change to an `ignored` or `pinned` path template code reads from, on a branch with no alignment or waiver | the template: the files its branch changed since `origin/main`, outside Markdown |
| `path-argument` | a path argument that matches no file | the paths `pnpm cella style` takes |

A checkout without a merge base with `origin/main` cannot tell which lines a branch changed: the gate then names the
checks it skipped on stderr.

`@cellajs/cli/style` also exports the helpers the template's skill scripts read class strings with.

## Configuration

Upgrade behavior lives in `cella/cella.config.ts`, which a new app gets from the template and no upgrade merges. Every
key sits at the top level, and your editor shows what each one does:

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

To deviate files or folders from the template:

- **`ignored`**: files excluded from upgrades, existing and new. An entry may name a path your app does not have, to
  keep it from arriving.
- **`pinned`**: files your app controls whole; existing, modified and deleted files are kept as the app has them.

Every run warns about an entry that does nothing: an `ignored` path neither your app nor upstream has, and a `pinned`
entry inside an `ignored` path, one upstream does not have (the file is your app's own), or one identical to upstream,
which only drops upstream's next change to it.

## Upstream tracking

`upstreamTrack` sets how the CLI follows upstream cella. `release`, the default for most apps, upgrades to the latest
cella release tag, and each bump maps to a changelog. `branch` follows the tip of `upstreamBranch`, for cella
maintainers and active development.

`--track` overrides the mode for one run, and `--ref` pins one upstream point: a commit sha, a release tag or an
upstream branch name, resolved on the upstream remote (`main` is upstream's `main`). The ref must be on `upstreamBranch`
or in an upstream release; a release tag upgrades as that release, anything else is recorded like branch tracking.

```bash
pnpm cella upgrade --track branch
pnpm cella upgrade --ref 4f7d87c
```

A run never upgrades to a point behind the last upgrade. When an earlier `--ref` or `--track branch` run went past the
latest release, release tracking says `nothing to upgrade` until a newer release exists, and a `--ref` behind the last
upgrade is refused. Either way the run changes nothing and leaves you on the branch you started from.

## Upgrade workflow

`pnpm cella upgrade` never commits to the trunk directly:

```
main ──▶ cella/upgrade/<stamp> ──(3-way merge)──▶ PR ──(squash)──▶ main
```

It runs a real git three-way merge, in stages: each run advances the upgrade one stage, and the run that commits never
ships. The pause on the committed branch is where drift triage (`pnpm cella analyze` reads the committed HEAD) and
follow-up commits happen.

1. **The first run** cuts the branch and merges. A clean merge is committed right away, after `pnpm install` and
   `pnpm check` reconcile the dependencies, and the run stops on the branch. A conflicted merge stops before the commit:
   resolve it in your editor, `git add` the files and rerun to commit.
2. **The next run** ships the committed branch: it pushes to `origin`, opens a PR into the trunk with `gh`, titled like
   the upgrade commit, and switches you back to the trunk.

Before it merges, the first run prints upstream's range and checks that it can go ahead. It stops without changing
anything when upstream needs a newer `@cellajs/cli` than the one running, or changed its own CLI config in ways yours
does not follow (see [Upstream changes that never merge](#upstream-changes-that-never-merge)): the temporary branch is
removed and you are back where you started. After the merge it prints the package.json merge, then the merge summary and
`next steps`.

The upgrade commit has a single parent (`chore: upgrade cella to <sha>`): the PR holds the incremental diff alone. Let
the rerun commit: a manual `git commit` records a merge commit, whose PR lists upstream's whole history. Ancestry lives
in the committed `cella/cella.manifest.json` and the local `refs/cella/last-upgrade`. Each upgrade branch is safe to
delete once its PR merges.

`upgrade` also runs from a linked git worktree while another worktree has the trunk checked out: it never switches to
the trunk, cuts from `origin/<trunk>` when the local trunk is behind, and detaches at the trunk after shipping. When
HEAD builds on that start point, as a branch holding a CLI bump or an alignment's renames does, the upgrade branch is
cut from HEAD and those commits ride in the upgrade PR.

A rerun with conflicts left lists them and stops. When `pnpm check`, the push or `gh` fails, the run reports it and
prints the steps left to do by hand.

## Analyze output

`pnpm cella analyze` leaves your files and branches alone: it fetches upstream and records the upgrade point in git
(`refs/cella/last-upgrade` and a local graft). It prints its file sections in the order they need you: what merges on
its own first (`behind`, `diverged`), then pinned files, drifted files, and the upstream changes the upgrade leaves out.
Large groups collapse into a row per folder or kind, and `--all` lists every path.

Analyze and upgrade both end with `next steps`, numbered in the order you take them: the review page, the command to run
next, and the alignments the upgrade brings or that are still open.

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

Without a terminal (piped, or read by an agent) each alignment row also gets its id, for `pnpm cella align show <id>`.

## Alignments

Upstream ships an alignment for every change that app code has to follow, in `cella/alignments/<id>/`: a README
(frontmatter, title, summary, then the steps) and sometimes a codemod. Alignments stay upstream. The upgrade never
brings that folder into the app and removes a copy it finds; `align` reads them from the upstream commit the app last
upgraded to.

The frontmatter says what the change asks of the app: `breaking`, `clientCacheBump`, `caughtBy` (`compiler`, `tests` or
`nothing`: what catches app code the change leaves behind), `generate` (the change needs `pnpm generate`), `grep` (terms
app code may still use) and, beside a codemod, its `roots`. A `grep` term that starts and ends with a letter or digit
matches as a whole word; any other term, such as `.results`, matches anywhere in a line.

The app keeps one small record, `cella/cella.alignments.json`, listing the alignments it has not handled yet. The
upgrade adds the ones that arrive with it, `align mark` removes them, and the file is deleted once the list is empty. No
file means nothing is pending, so a new app starts without one.

Alignments are information, never a gate. `analyze` and each upgrade run list them under `next steps`; in `analyze` the
ones in the upgrade range *arrive with this upgrade* and become open once the upgrade lands. The upgrade PR lists the
open alignments with links. Handle them in the upgrade PR or later; they stay listed until marked.

```bash
pnpm cella align                    # open alignments, with summary and links
pnpm cella align --all              # every upstream alignment, handled or not
pnpm cella align show <id>          # one alignment's README and what git tells about it
pnpm cella align run <id>           # run its codemod, report only
pnpm cella align run <id> -- rewrite frontend/src   # run it with your own arguments
pnpm cella align mark <id> [...]    # record alignments as handled
```

Next to its README, `align show` shows what git can tell: the upstream commit and PR that added the alignment, the other
alignments of that commit, the files of that commit the app pins, ignores or changed, and the lines of app code that
hold one of its `grep` terms. Only files that differ from the upstream commit of the last upgrade count.

`align show` also works before the upgrade that brings an alignment: it reads one the last upgrade does not have from
the fetched upstream branch.

`align run` extracts the alignment to `node_modules/.cache/cella/alignments/<id>/` and runs its codemod with `tsx` from
your app root. Everything after `--` goes to the codemod as given; without it the codemod gets `inventory` and the
alignment's `roots`, the report-only run.

A file identical to upstream is the way upstream wants it, and a rewrite there only creates drift. So after the codemod
runs, each file that was byte-identical to the upstream commit of the last upgrade gets its upstream content back, and
the run prints how many it restored. Files your app changed keep the codemod's rewrite. A codemod run by hand from the
extracted folder has no such protection.

## Merge rules

For each file, `upgrade` compares app and upstream **content** and resolves it per the table below. Unconfigured files
converge on upstream; `ignored` and `pinned` let you opt out:

| Scenario | `ignored` | `pinned` | Default |
|----------|:---------:|:--------:|:-------:|
| Content identical | ✅ Keep | ✅ Keep | ✅ Keep |
| Content differs | ⏭️ Skip | ✅ Keep yours | ⬇️ Take upstream |
| New upstream file | ⏭️ Skip | ✅ Keep (respect deletion) | ➕ Add file |
| Deleted in upstream | ✅ Keep | ✅ Keep | 🗑️ Delete |
| Only in your app | ✅ Keep | ✅ Keep | ✅ Keep |

**Choosing an override:** `ignored` means the file never merges and is fully hidden (app-specific docs, assets, config
you own). `pinned` means your version always wins but stays visible (files you customize). Run `pnpm cella analyze`
first to preview.

## Status indicators

During analysis and upgrade, files are displayed with status indicators:

| Symbol | Label | Meaning | Action |
|:------:|-------|---------|--------|
| ◇ | `managed` | Package/config file changed | Handled separately by cella |
| ⨂ | `ignored` | Protected by ignored config | Excluded from upgrades |
| ✓ | `identical` | App matches upstream | No action needed |
| ↑ | `ahead` | App changed (pinned), upstream did not | Protected, keeping app |
| ! | `drifted` | App changed, not protected | At risk, consider pinning |
| ↓ | `behind` | Upstream changed, app did not | Will update from upstream; a pinned file keeps the app copy (masking pin) |
| ⇅ | `diverged` | Both sides changed | Will merge from upstream |
| ⨀ | `pinned` | Pinned and both changed (a deletion counts), or protected and moved upstream | Protected, keeping app: review, see below |
| → | `renamed` | Upstream moved a file the app left unchanged | Takes upstream's copy at the new path |
| ✗ | `deleted` | App deleted it | Stays deleted |
| + | `local` | Only in app, never in upstream | No action needed |

### Protected but behind upstream

A pinned or ignored file wins whole-file: when upstream also changed it since the last upgrade, upstream's hunks are
dropped, not merged. That is easy to miss, as with a pinned stylesheet missing new upstream utilities that merged
components rely on. Both commands call it out:

- `analyze` lists them in a `⚠ protected but behind upstream` section with the number of lines upstream changed,
  together with the ignored files only upstream changed. Generated output the app regenerates itself (`sdk/gen`,
  `*.gen.*` files) is left out. `--list` and `--json` include them in `--scope all` and `--scope protected`.
- `upgrade` prints the same list at the end of its summary, right when the drop happens.

```
⚠ 5 protected files kept the app version, dropping upstream changes:
  ⨀ frontend/src/styling/tailwind.css · 21 lines changed upstream
  ⨂ shared/config/default.ts · 4 lines changed upstream
  ⨂ shared/config/staging.ts · 2 lines changed upstream
  ⨂ 2 ignored binary files, such as frontend/public/static/marketing/app-1.webp
  pinned/ignored files where upstream also changed since the last upgrade; the app side wins on conflict, so review what upstream changed and adopt what you need.
```

The check is relative to the last upgrade: a drop in an earlier upgrade shows as plain `ahead` afterwards. For that case
the `↑ protected in app` section counts the `upstream lines absent` from each pinned file: upstream content the app
never received, deliberately or not. The [review page](#review-page) shows both differences.

To pull upstream into every pinned file at once, run `upgrade --unpinned`: pins are lifted for that run (managed files
stay pinned) and the merge uses the full upstream history: changes earlier upgrades dropped come back too. Review the
staged merge in your editor and keep what you want; `analyze --unpinned` previews it.

### Upstream changes that never merge

Two more kinds of upstream change never reach the app on their own, and both commands report them:

- **Ignored paths changed upstream.** Upstream changed, added or deleted a file under an `ignored` entry (app-owned
  module folders included) that the app left untouched or does not have. No conflict marks it. This is where new config
  keys and version bumps under `shared/config` show up.
- **Upstream CLI config changes.** Entries upstream adds to its own `pinned`, `ignored` or `packageJsonKeys` never
  arrive, because `cella/cella.config.ts` never merges. The report names each entry upstream added that your config
  lacks (`+`) and each entry upstream dropped that your config still has (`−`). It reads upstream's config without
  running it.

`upgrade` stops before a new merge when it finds such config entries. The merge runs on your config: with a list that is
behind, a path upstream now ignores or pins would arrive as an ordinary merged file. Add or drop the entries that fit
your app, commit and rerun, or pass `--keep-config` to merge with your config as it stands. The rerun that commits an
already staged merge never stops for this.

### Review page

The terminal lists files; the review page shows their diffs, side by side and highlighted, on one page in your browser
under the same section titles. `analyze` and `upgrade` write it whenever a list has files, and list it first under
`next steps`. A diff shows what upstream changed since the last upgrade, except in two sections only `analyze` has:
`protected in app` compares the app with upstream as both are now, and `drifted` shows what the app changed.

`upgrade` opens the page in your browser when it runs in a terminal: the files on it are upstream changes the merge did
not bring in, and the committed upgrade branch is where you adopt them. `analyze` only lists it. The page lives in the
git directory, out of `git status`, and each run overwrites it. A page with too many diffs lists the rest by path, as it
does files without a text diff.

## Package.json merge

`packageJsonKeys` names the package.json sections that merge from upstream, and `false` merges no package.json at all.
Each section merges three-way against the package.json of your last upgrade:

- An entry your app never touched follows upstream: it is added, updated or removed.
- An entry your app added or changed stays; only a strictly higher upstream version still bumps it, never in `scripts`.
- An entry your app removed is not re-added.
- A dependency or script upstream dropped stays while your own code still uses it, and the upgrade warns about each one
  it kept.
- `exports` are add-only and merge only when both sides are subpath maps (`{ ".": …, "./config": … }`).
- A workspace upstream added since your last upgrade arrives with its package.json as upstream has it.
- A merged section is sorted alphabetically, except `scripts`: they keep upstream's order, and a script only your app
  has stays after the one it follows.

`type` always merges, whatever `packageJsonKeys` lists: it follows upstream where your app kept the previous value, and
a package.json without `type` gets upstream's. Set it yourself (for example `"commonjs"`) to keep your own.

## Audit

`pnpm cella audit` reports the outdated packages, the runtime pins and the security plan, with no prompts, and writes
nothing. Outside a git repository it finds no Dockerfile, and only the image pins go unread. `pnpm cella audit fix`
works in two layers, in this order:

1. **Updates.** It lists the outdated packages and runtime pins in one table and asks once which to update. Rows with a
   high or critical advisory start ticked; submitting with nothing ticked skips this layer.
2. **Security.** It audits the workspace as the picked updates leave it and brings three settings in
   `pnpm-workspace.yaml` in line with that audit.

Nothing is written until the end: the updates and the security settings land together, with a single `pnpm install`.
Cancelling any prompt leaves the workspace as it was.

### Runtime pins

The audit also checks the runtimes the workspace pins to an exact version, which `pnpm audit` never sees, against their
own release feeds:

| Pin | Feed | Dot |
|-----|------|-----|
| root `engines.node` | nodejs.org release index | red when a newer release in the line is a security release |
| root `packageManager` (pnpm) | npm registry and its advisory database | red when the newer version fixes an advisory on yours |
| `FROM image:2.8-suffix` in tracked Dockerfiles | Docker Hub tags | yellow when your tag has gone stale while a newer one is pushed |

A pin moves within its major, to the newest version older than `minimumReleaseAge`. A Node bump waits until Docker Hub
has the `node:<version><suffix>` images the Dockerfiles build from, and the audit prints what is left to do on your
machine: switching its Node, and building each changed image.

### This machine

The pins say what the workspace should run; the tools on your machine can still miss security fixes. Below the table the
audit shows, for each one, what it misses:

| Tool | Which one | Feed |
|------|-----------|------|
| Node | the one running the audit, which also runs the workspace | nodejs.org release index |
| pnpm | the one your terminal starts, before it switches to `packageManager` | npm advisory database |
| gh | the one on your PATH | OSV |

A tool that misses a fix gets a dot and the command to fix it, for the way it was installed (Volta, Homebrew, or pnpm's
own `self-update`), naming the newest version that has every fix and is older than `minimumReleaseAge`. The audit does
not change these tools itself.

### Holding a package back

To keep a package off the update list, use pnpm's own setting, with the reason as a comment. `pnpm outdated` skips it,
so the audit does too, and `pnpm audit` still checks it:

```yaml
updateConfig:
  ignoreDependencies:
    - typescript # 7 drops the JS compiler API that SDK codegen needs
```

### Security overrides

The security layer treats its overrides as output, not as configuration. Every run it drops them, resolves the workspace
without them in a temporary copy, and puts back only the ones a current advisory still needs. An override whose package
now resolves to a fixed version is gone after the next run. The workspace changes once, at the end, and only when the
outcome differs from what is there.

| Setting | What the audit owns | What it leaves alone |
|---------|---------------------|----------------------|
| `overrides` | keys with a version selector: `pkg@<1.2.3` | keys without one (`pkg`) and parent-scoped keys (`parent>pkg`) |
| `minimumReleaseAgeExclude` | `pkg@1.2.3` entries, removed once that version is older than `minimumReleaseAge` | name-only entries |
| `auditConfig.ignoreGhsas` | every entry, removed when the advisory no longer applies or a fix arrives | |

To keep an override whatever the audit finds, write it without a version selector. For each advisory the audit looks up
the published versions itself; it does not trust the patched version an advisory claims. Most outcomes need no answer
from you:

- **A fix that fits.** The audit writes an override. When the fix lies inside the range the parents ask for, the
  lockfile holds the fixed version on its own, and the following run drops the override.
- **A breaking fix** (another major, or another minor below 1.0), or a fix for a package you depend on directly: you
  choose between leaving it open, applying the override and ignoring the advisory. An override that was in place before
  the run is applied again without asking.
- **A fix younger than `minimumReleaseAge`**: you choose between waiting and installing it now with an exclude.
- **No fix published**: you are asked whether to ignore the advisory until one is.

## Adopt from forks

Upstream can pull modifications from local forks and adopt them file by file. List your local forks in
`cella.config.ts`:

```typescript
forks: [
  { name: 'raak', localPath: '../raak', pullBranch: 'main' },
],
```

`pnpm cella adopt` asks for a fork, fetches its `pullBranch` and builds a clean local `contrib/<fork>` branch with only
that fork's contributed files. Press `d` on a file to open its diff in your browser. Accepted files are checked out from
the contrib branch and staged for review.

## Stats of a branch

`pnpm cella stats` counts the whole repository. With `--since <ref>` it counts what the current branch changed since it
left that ref, by kind of file, which is what a pull request into the ref shows. Only committed work counts. It reads
git alone and runs in any repository: one that is no app runs the published CLI with `pnpm dlx @cellajs/cli stats`.

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

Source lines are also split by what they hold. A diff shows changed lines only. A comment is recognized by how the line
starts (`//`, `/*`, `*`, `{/*`), and a line of a template literal that starts that way counts as a comment too.

## Trying a CLI change

A change to a tool reaches apps with a CLI release. To try one on an app first, run `pnpm build` here and put this
checkout in place of the app's package:
`rm -rf <app>/node_modules/@cellajs/cli && ln -s "$PWD" <app>/node_modules/@cellajs/cli`. An install in the app puts the
published package back, so link again after every `pnpm install`.
