# @cellajs/cli

Keep your app in sync with upstream [cella template](https://github.com/cellajs/cella) updates while preserving your
customizations.

## Usage

From your monorepo root, run `pnpm cella` for the interactive menu, or call a service directly:

```bash
pnpm cella analyze
pnpm cella sync
pnpm cella audit
```

## Services

| Service | Description |
|---------|-------------|
| `analyze` | Dry run to see what would change on sync. It leaves your files and branches alone but updates git metadata: it fetches upstream and writes `refs/cella/last-sync` and a graft for the sync base |
| `sync` | Merge upstream changes onto a fresh branch, sync package.json and open a squash-merge PR into `main` |
| `migrate` | List the upstream migration notes this app has not handled yet, read them, run their codemods, record them |
| `audit` | Check for outdated packages and vulnerabilities |
| `stats` | Count files by category and workspace package |
| `forks` * | Run normal sync inside local fork repositories |
| `contributions` * | Pull and adopt changes from local forks |

\* `forks` and `contributions` only appear when you have `forks` configured in `cella.config.ts`. 

## CLI options

```bash
pnpm cella [service] [options]
```

Per-service help: `pnpm cella <service> --help`.

| Service | Useful options |
|---------|----------------|
| analyze | `--log`, `--list`, `--json`, `--scope <all\|risk\|protected>`, `--track <release\|branch>`, `--ref <ref>`, `--diff <path>`, `--open-diff <path>` |
| sync | `--log`, `--hard`, `--unpinned`, `--track <release\|branch>`, `--ref <ref>`, `--keep-config` |
| migrate | `--all`, `--json`, `--show <id>`, `--extract <id>`, `--run <id> [-- <codemod args>]`, `--script <file>`, `--mark <ids...>` |
| audit | `--list`, `--force`, `--check-overrides` |
| forks | `--fork <name>`, `--log`, `--hard`, `--keep-config`, `-V, --verbose` |
| contributions | `--fork <name>`, `--list`, `--json`, `--diff <path>` |
| stats | `--coverage`, `-V, --verbose` |

| Global flag | Description |
|-------------|-------------|
| `-v, --version` | Output the current version |
| `-h, --help` | Display help for a command |

## Configuration

Sync behavior lives in `cella.config.ts` at your monorepo root (a sensible default ships with new
apps). To deviate files or folders from the template:

- **`ignored`** — files completely excluded from sync (existing and new)
- **`pinned`** — full fork control: existing, modified, or deleted files are preserved

An `ignored` entry may name a path your app does not have, to keep it from arriving (a file upstream
has and your app deleted). Every run warns `ignored entry not found` only when neither your app nor
upstream has the path. Upstream is read at `settings.upstreamBranch` as last fetched; before the
first fetch, every `ignored` entry missing from your app warns.

## Upstream tracking

The sync CLI tracks upstream cella one of two ways, set via `settings.upstreamTrack`:

| Mode | Behavior | For |
|------|----------|-----|
| `release` (default) | Sync to a last cella release tag. Stable and reviewable — each bump maps to a changelog. | Most forks |
| `branch` | Follow the bleeding-edge tip of `settings.upstreamBranch`. | cella maintainers, active development |

For a one-off run that ignores the configured mode, pass `--track`:

```bash
pnpm cella sync --track branch   # follow the tip once, without editing config
```

To sync to one specific upstream point, pin it with `--ref` (it wins over `--track`): a commit sha,
a release tag or an upstream branch name, resolved on the upstream remote (`main` is upstream's
`main`, not yours). The ref must be on `settings.upstreamBranch` or in an upstream release; a
release tag syncs as that release, anything else is recorded like branch tracking.

```bash
pnpm cella sync --ref 4f7d87c      # sync up to this upstream commit
```

A run never syncs to a point behind the last sync: when an earlier `--ref` or `--track branch` run
went past the latest release, release tracking ends with a `nothing to sync` message until a newer
release exists, instead of reverting what the app already has. A `--ref` behind the last sync is
refused. Either way the run changes nothing and leaves you on the branch you started from.

## Sync workflow

`pnpm cella sync` never commits to `main` directly. 

```
main ──▶ cella/sync/<stamp> ──(3-way merge)──▶ PR ──(squash)──▶ main
```

It runs a real git 3-way merge. `sync` is **idempotent and staged**: each run advances the sync
one stage, and the run that commits never ships — the pause on the committed branch is where
drift triage (`pnpm cella analyze` diffs committed HEAD) and follow-up commits happen.

1. **First run** cuts the branch and merges. A clean merge is committed right away: dependencies
   are reconciled (`pnpm install` + `pnpm check`), everything is staged, and the delta is
   committed — then the run stops on the branch. A conflicted merge stops earlier so you can
   resolve in your IDE (`git add` the resolved files) and re-run to commit.
2. **Final re-run `pnpm cella sync`** on the committed branch ships it: pushes to `origin`,
   opens a PR into `main` (via `gh`), and switches you back to `main`.

Before the merge starts, a first run checks that it can go ahead, and stops without changing
anything when it cannot: the temporary branch is removed again and you are back on the branch you
started from. It stops when upstream needs a newer `@cellajs/cli` than the one running, and when
upstream changed its own sync config in ways yours does not follow (see
[Upstream changes that never sync](#upstream-changes-that-never-sync)).

`sync` also runs from a linked git worktree while another worktree has `main` checked out: it
never switches to `main`. It compares `main` with `origin/main` by ref and cuts the sync branch
from `main`; when `main` is behind and checked out elsewhere, it cuts from `origin/main` instead
and leaves `main` as it is. After shipping, the worktree detaches at `main` instead of switching
to it.

When the commit stage runs, the in-progress merge state (`MERGE_HEAD`) is discarded, so the staged delta
collapses into a **single-parent commit** (`chore: sync upstream cella <sha>`). This keeps the PR
to one clean commit with the incremental diff — a two-parent merge commit would instead list the
upstream branch's entire history, because the fork doesn't share pushed ancestry with upstream
and the local `git replace` graft that makes merges incremental is never pushed. Ancestry lives
in `refs/cella/last-sync` (and the committed `cella.manifest.json` for fresh clones), so
`git merge-base` keeps working across throwaway branches — each is safe to delete once its PR
lands. The three-segment name can't collide with git's ref namespacing.

If conflicts remain when you re-run, `sync` lists them and stops (never starting a second cycle
mid-merge). If `pnpm check`, the push, or `gh` fails, it degrades gracefully — reporting the
issue and printing the remaining manual steps:

```bash
git push -u origin cella/sync/<stamp>
gh pr create --base main --head cella/sync/<stamp> --fill
```

## Migration notes

Upstream ships a note for every change that app code has to follow, in `cella/migrations/<id>/`:
a README (frontmatter, title, summary, then the steps) and sometimes a codemod. The notes stay
upstream. The sync never brings that folder into the app and removes a copy it finds; `migrate`
reads the notes from the upstream commit the app last synced to, which the sync already fetched.

The app keeps one small record, `cella/cella.migrations.json`, listing the notes it has not
handled yet. The sync adds the notes that arrive with it, `migrate --mark` removes them, and the
file is deleted once the list is empty. No file means nothing is pending, so a new app starts
without one.

Notes are information, never a gate. Each sync run, and `analyze`, ends with one line:

```
migration notes: 94 of 97 handled · 3 arrived with this sync · 3 open: pnpm cella migrate
```

and the sync PR lists the open notes with links. Handle them in the sync PR or later; they stay
listed until marked.

```bash
pnpm cella migrate                    # open notes, with summary and links
pnpm cella migrate --show <id>        # one note's README
pnpm cella migrate --run <id>         # run its codemod, report only
pnpm cella migrate --run <id> -- rewrite frontend/src   # run it with your own arguments
pnpm cella migrate --extract <id>     # its folder under node_modules/.cache/cella/migrations/<id>/
pnpm cella migrate --mark <id> [...]  # record notes as handled
```

`--run` extracts the note and runs its codemod with `tsx` from your app root. Everything after `--`
goes to the codemod as given; without it the codemod gets `inventory` and the note's `roots`, the
report-only run. The codemod is the one script in the note folder; when a folder holds several,
name it with `--script <file>`.

A codemod's roots cover template-owned files too, and a file that is identical to upstream already
is the way upstream wants it: upstream may have changed it after writing the codemod, so a rewrite
there only creates drift. Before the codemod starts, `--run` notes which files are byte-identical
to the last synced upstream commit (`upstream.commit` in `cella/cella.manifest.json`, during a
staged sync the incoming commit). After the run, each of those files the codemod changed gets its
upstream content back, and the run prints how many it restored. Files your app changed keep the
codemod's rewrite. The codemod's own report still counts the restored files, in a report-only run
too. A codemod run by hand from the `--extract` folder has no such protection.

## Sync rules

For each file, `sync` compares fork and upstream **content** (blob comparison) and resolves it
per the table below. Unconfigured files converge on upstream; `ignored` and `pinned` let you opt
out:

| Scenario | `ignored` | `pinned` | Default |
|----------|:---------:|:--------:|:-------:|
| Content identical | ✅ Keep | ✅ Keep | ✅ Keep |
| Content differs | ⏭️ Skip | ✅ Keep yours | ⬇️ Take upstream |
| New upstream file | ⏭️ Skip | ✅ Keep (respect deletion) | ➕ Add file |
| Deleted in upstream | ✅ Keep | ✅ Keep | 🗑️ Delete |
| Only in your app | ✅ Keep | ✅ Keep | ✅ Keep |

**Choosing an override:** `ignored` = file never syncs and is fully hidden (app-specific docs,
assets, config you own). `pinned` = your version always wins but stays visible (files you
customize). Unconfigured = syncs automatically. Run `pnpm cella analyze` first to preview.

### Aggressive sync flags

Two opt-in flags make `sync` more aggressive. Both resurface full upstream history (natural merge-base, not the last-sync point), so expect a larger diff and a post-run warning — cherry-pick deliberately. They compose (`--hard --unpinned`).

| Flag | Effect |
|------|--------|
| `--hard` | Overwrites `drifted` files with upstream (local-only changes are replaced) |
| `--unpinned` | Ignores `pinned` files so upstream surfaces as `behind`/`diverged`; managed files stay pinned |

## Status indicators

During analysis and sync, files are displayed with status indicators:

| Symbol | Label | Meaning | Action |
|:------:|-------|---------|--------|
| ◇ | `managed` | Package/config file changed | Handled separately by cella |
| ⨂ | `ignored` | Protected by ignored config | Excluded from sync |
| ✓ | `identical` | Fork matches upstream | No action needed |
| ↑ | `ahead` | Fork changed (pinned), upstream did not | Protected, keeping fork |
| ! | `drifted` | Fork changed, not protected | At risk, consider pinning |
| ↓ | `behind` | Upstream has changes | Will sync from upstream |
| ⇅ | `diverged` | Both sides changed | Will merge from upstream |
| ⨀ | `pinned` | Both changed, fork wins | Protected, keeping fork — review, see below |
| + | `local` | Only in fork, never in upstream | No action needed |

### Protected but behind upstream

A pinned or ignored file wins whole-file: when upstream also changed it since the last sync,
upstream's hunks are dropped, not merged. That is easy to miss (a pinned stylesheet quietly
missing new upstream utilities that synced components rely on), so both commands call it out:

- `analyze` lists them in a `⚠ protected but behind upstream` section (pinned files as ⨀,
  ignored as ⨂) with the number of lines upstream changed; `--list`/`--json` include them in
  `--scope all` and `--scope protected` (`--json` adds `upstreamChanged` and `upstreamChangedLines`).
- `sync` prints the same list at the end of its summary, right when the drop happens.

Both lists end with one `git diff <last-sync>..<upstream> -- <entry>` line per `pinned` or
`ignored` entry that holds a listed file, to paste. The range is what makes it useful:
`git diff HEAD <upstream> -- shared/config` shows your whole config against the template's, while
`<last-sync>..<upstream>` shows only what upstream changed since your last sync.

```
⚠ 3 protected files kept the fork version, dropping upstream changes:
  ⨀ frontend/src/styling/tailwind.css · 21 lines changed upstream
  ⨂ shared/config/default.ts · 4 lines changed upstream
  ⨂ shared/config/staging.ts · 2 lines changed upstream
  pinned/ignored files where upstream also changed since the last sync; the fork side wins on conflict, so diff each against upstream (analyze --open-diff <path>) and adopt what you need.
  what upstream changed since the last sync, per pinned/ignored entry:
    git diff e9a8d485e..a81e3353b -- frontend/src/styling/tailwind.css
    git diff e9a8d485e..a81e3353b -- shared/config
```

Diff each against upstream (`cella analyze --open-diff <path>`) and adopt what you need. The
check is relative to the last sync point: a drop that happened in an earlier sync only shows up
as plain `ahead` afterwards. For that case the `↑ protected in fork` section annotates pinned
files with `· N upstream lines absent` (lines upstream has that the fork lacks, compared at the
tips, `--json`: `upstreamLinesAbsent`). That is upstream content the fork never received,
deliberately or not: diff and decide. Ignored files are not annotated.

### Upstream changes that never sync

Two more kinds of upstream change never reach the fork on their own. `analyze` prints both after
its summary, and `sync` after its merge summary:

- **Ignored paths changed upstream.** Upstream changed, added or deleted a file under an `ignored`
  entry (app-owned module folders included) and the fork left it untouched. No conflict marks it,
  so this is where new config keys and version bumps under `shared/config` show up. Each `ignored`
  entry gets one line with a file count and a `git diff <last-sync>..<upstream> -- <entry>` line to
  paste. Files both sides changed stay in the section above, and generated output the fork
  regenerates itself (`sdk/gen`, `*.gen.*` files) is left out. `--list`/`--json` include these
  files in `--scope all` and `--scope protected` (`--json`: `upstreamOnly`).
- **Upstream sync config changes.** `cella/cella.config.ts` never syncs, so entries upstream adds to
  its own `overrides.pinned` or `overrides.ignored`, and keys it adds to `settings.packageJsonSync`
  (the template your config started from), never arrive. The report names each entry upstream added
  that your config lacks (`+`) and each entry upstream dropped that your config still has (`−`). It
  reads upstream's config without running it and never edits yours. `--json` puts the lists on the
  `cella/cella.config.ts` entry (`upstreamOverrides`).

```
⚠ ignored paths changed upstream · 1 file under 1 entry
  ⨂ frontend/src/modules/marketing · 1 file
    git diff e9a8d485e..a81e3353b -- frontend/src/modules/marketing
  the fork left these untouched and ignored paths never sync: diff and adopt what you need.

⚠ upstream changed its sync config · 2 entries to review
  + pinned: backend/src/bundle-config.ts
  + packageJsonSync: exports
  cella/cella.config.ts never syncs: add or drop these by hand where they fit your app.
```

`analyze` only reports these. `sync` checks the sync config before a new merge and stops when it
finds entries: the merge runs on your config, so with a list that is behind, a path upstream now
ignores or pins would arrive as an ordinary synced file (upstream renamed an ignored folder, your
list still names the old one). Nothing has changed at that point. Add or drop the entries that fit
your app in `cella/cella.config.ts`, commit and rerun, or pass `--keep-config` to merge with your
config as it stands; the report then follows the merge summary as before. The rerun that commits an
already staged merge never stops for this.

```bash
pnpm cella sync --keep-config   # merge although upstream changed its sync config
```

## Package.json sync

`packageJsonSync` controls which package.json sections sync from upstream:

```typescript
packageJsonSync: ['dependencies', 'devDependencies', 'scripts']
```

**Supported keys:** `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, `scripts`, `engines`, `packageManager`, `overrides`, `exports`, `pnpm`

Each section merges three-way against the merge-base package.json (upstream as of your last
sync). An entry your fork never touched follows upstream: it is **added**, **updated** (a rewritten
script, a changed range) or **removed** when upstream dropped it. An entry your fork added or
changed stays as it is; only a strictly higher upstream version still bumps it, and never for
`scripts`. An entry your fork removed is not re-added. A dependency or script upstream dropped
stays while your own code still uses it: files that differ from upstream and scripts your fork
added or changed are searched for an import of the package, a run of its CLI, or a package manager
command that runs the script. The sync lists every change and warns about each entry it kept this
way, so you can remove it once your code no longer needs it. `exports` are add-only: an entry your fork
already defines is never rewritten, and `exports` only merges when both sides are subpath maps
(`{ ".": …, "./config": … }`). A workspace upstream added since your last sync arrives with its
package.json copied verbatim.

`type` always syncs, whatever `packageJsonSync` lists: it follows upstream where your fork kept the
previous value, and a package.json without `type` gets upstream's. Set it yourself (for example
`"commonjs"`) to keep your own.

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
contributed files. Accepted files are checked out from the contrib branch and staged for review.
`--list` prints the result as tab-separated rows (fork, status, kind, changedAt, path) for tooling.
