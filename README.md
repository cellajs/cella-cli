# @cellajs/cli

Upgrade your app with upstream [cella template](https://github.com/cellajs/cella) changes while preserving your
customizations.

## Usage

From your monorepo root, run `pnpm cella` for the interactive menu, or call a service directly:

```bash
pnpm cella analyze
pnpm cella upgrade
pnpm cella audit
```

## Services

| Service | Description |
|---------|-------------|
| `analyze` | Dry run to see what would change on upgrade. It leaves your files and branches alone but updates git metadata: it fetches upstream and writes `refs/cella/last-upgrade` and a graft for the upgrade base |
| `upgrade` | Merge upstream changes onto a fresh branch, merge package.json and open a squash-merge PR into `main` |
| `align` | List the upstream alignments this app has not handled yet, read them, run their codemods, record them |
| `audit` | Update outdated packages and runtime pins, then rebuild the security overrides from a fresh audit; report the security fixes this machine's Node, pnpm and gh miss |
| `stats` | Count files by category and workspace package; with `--since <ref>`, count what the current branch changed, by kind of file |
| `forks` * | Run the upgrade inside local fork repositories |
| `contributions` * | Pull and adopt changes from local forks |

\* `forks` and `contributions` only appear when you have `forks` configured in `cella.config.ts`. 

## CLI options

```bash
pnpm cella [service] [options]
```

Per-service help: `pnpm cella <service> --help`.

| Service | Useful options |
|---------|----------------|
| analyze | `--list`, `--json`, `--scope <all\|risk\|protected>`, `--all`, `--track <release\|branch>`, `--ref <ref>`, `--unpinned` |
| upgrade | `--track <release\|branch>`, `--ref <ref>`, `--keep-config`, `--unpinned` |
| align | `--all`, `--json`, `--show <id>`, `--extract <id>`, `--run <id> [-- <codemod args>]`, `--mark <ids...>` |
| audit | `--list` |
| forks | `--fork <name>`, `--keep-config` |
| contributions | `--fork <name>`, `--json` |
| stats | `--since <ref>`, `--md`, `-V, --verbose` |

| Global flag | Description |
|-------------|-------------|
| `-v, --version` | Output the current version |
| `-h, --help` | Display help for a command |

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
modules included), one upstream no longer has (the file is your app's own now), and one identical
to upstream, which only drops upstream's next change to it.

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
to it.

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
`generate` (the change needs `pnpm generate`), `grep` (words app code may still use) and, beside a
codemod, its `roots`.

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
or changed, and the lines of app code that hold one of its `grep` words. Only files that differ
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
   this layer.
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

## Contributions (pull from forks)

Upstream can pull modifications from local forks and selectively adopt them.

To use it, list your local forks in `cella.config.ts`:

```typescript
forks: [
  { name: 'raak', localPath: '../raak', pullBranch: 'main' },
],
```

### Pulling contributions

Run `pnpm cella contributions` (or pick **contributions** from the menu). Select a fork; cella
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
