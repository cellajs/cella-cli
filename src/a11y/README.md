# a11y

`pnpm cella a11y` audits the app against WCAG 2.2 Level A and AA on a testbed, signed in as the seeded admin
(`ADMIN_EMAIL` of `.env`), and fills the conformance ledger, `cella/a11y-ledger.json`. It visits every state of
`cella/a11y.ts` in light mode, and in dark mode for contrast: an axe scan, browser checks that axe cannot do, and a review
of the code for the rest.

## States

`cella/a11y.ts` lists the template's pages and states, following steps 2 and 3 of W3C's WCAG-EM: every page type, plus
overlays such as dialogs, sheets and menus. A state that exists only at one width carries its own browser settings, and
`forms` marks the states whose form the form probes submit. `cella/a11y.app.ts` adds the app's own.

## The ledger

The ledger holds one committed row per criterion: its status, the remarks for the report, the evidence and the open
checks. It carries the product's name (the root package name), and another product never reads it: a new app starts its
own with its first full run.

Each criterion names its checks: axe, a browser probe, a code check or a manual one. A failed check makes a row
Partially Supports. A row becomes Supports or Not Applicable only when all its checks ran and none is manual; the rest
stay open for a reviewer.

Only a complete run replaces the ledger. A run of some states (`--states`) or one with a failed visit (a page that
redirects, a check that cannot run) writes `ledger-partial.json` in the results folder, and a failed visit fails the run.
It leaves a screenshot and a JSON file under `review/`: what the page showed, its console errors and the steps that ran
before.

## Reviewers

Every full run leaves a packet per state under `review/`: a screenshot, the accessibility tree, facts about the page and
the Tab order. A reviewer judges the open criteria from those and records each decision with `a11y decide`; an agent's
decision stays provisional until a person confirms it. A later failure on a row a reviewer called Supports puts it back
to Partially Supports, and the checklist lists decided rows whose evidence names a file changed since.

## The report

`a11y report` renders the ledger as a draft VPAT and the checklist for the manual pass. With `--publish` it puts the
report where the app serves it and prints what the statement needs. It refuses while rows are open or decided by an agent
only, unless `--draft` publishes them as provisional.

## One state from a script

`openState('<id>')` from `@cellajs/cli/a11y` opens one state, signed in, to check a fix: it returns the page, its context
and `close`. Run the script from the app's root through `pnpm testbed -- node <script>`.
