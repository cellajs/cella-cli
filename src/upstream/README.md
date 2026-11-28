# Upgrades

`pnpm cella upgrade` brings upstream cella into an app and keeps the app's customizations; `pnpm cella analyze` is its
dry run. Both read `cella/cella.config.ts` ([Upgrades](../../README.md#upgrades) shows its keys).

## Merge rules

An upgrade compares each file's content in the app and upstream. A file no entry names converges on upstream.
`ignored` keeps a path out of upgrades, existing and new files alike, even one your app does not have. `pinned` keeps
your version whole but leaves it visible to `analyze`, for files you customize:

| Scenario            | `ignored` |          `pinned`          |     Default      |
| ------------------- | :-------: | :------------------------: | :--------------: |
| Content identical   |  ✅ Keep  |          ✅ Keep           |     ✅ Keep      |
| Content differs     |  ⏭️ Skip  |       ✅ Keep yours        | ⬇️ Take upstream |
| New upstream file   |  ⏭️ Skip  | ✅ Keep (respect deletion) |   ➕ Add file    |
| Deleted in upstream |  ✅ Keep  |          ✅ Keep           |    🗑️ Delete     |
| Only in your app    |  ✅ Keep  |          ✅ Keep           |     ✅ Keep      |

Every run warns about an entry that does nothing, such as a pin identical to upstream, which only drops upstream's next
change to it.

## Upstream tracking

`upstreamTrack: 'release'`, the default, upgrades to the latest cella release on `upstreamBranch`, and each bump maps to
a changelog. `'branch'` follows the tip of `upstreamBranch`, for cella maintainers and active development.

`--track` overrides the mode for one run, and `--ref` pins one upstream point: a commit sha, a release tag or an
upstream branch name.

```bash
pnpm cella upgrade --track branch
pnpm cella upgrade --ref 4f7d87c
```

A run never upgrades to a point behind the last upgrade: release tracking says `nothing to upgrade` until a newer
release exists, and a `--ref` behind it is refused.

## The three runs

`pnpm cella upgrade` never commits to the trunk directly:

```
main ──▶ cella/upgrade/<stamp> ──(3-way merge)──▶ PR ──(squash)──▶ main
```

It runs a git three-way merge in stages, and each run advances it one stage:

1. **The first run** cuts the branch, merges and stops with the merge staged, before anything from upstream runs. It
   lists what arrived that decides what runs: package scripts, dependencies from outside the registry, `pnpm` settings,
   patches, git hooks, and GitHub workflows and actions. Read them and the rest of the merge, since the next run's
   `pnpm check` runs it. Resolve a conflict in your editor and `git add` the files.
2. **The second run** runs `pnpm install` and `pnpm check`, commits the merge and stops on the branch. This is where
   `analyze` triages drift and you add follow-up commits.
3. **The third run** lists the changes CI will run with the repository's secrets, pushes to `origin`, opens a PR into
   the trunk with `gh` and switches you back to the trunk.

When `pnpm check`, the push or `gh` fails, the run prints the steps left to do by hand.

The first run changes nothing and stops when upstream needs a newer `@cellajs/cli`, when upstream changed its own CLI
config in ways yours does not follow (see [Upstream changes that never merge](#upstream-changes-that-never-merge)), or
when two paths differ only in letter case.

Let the rerun commit: the upgrade commit has a single parent, and its PR holds the incremental diff alone. A manual
`git commit` records a merge commit, whose PR lists upstream's whole history. An upgrade branch is safe to delete once
its PR merges.

`upgrade` also runs from a linked worktree while another has the trunk checked out. Commits on HEAD that build on the
trunk, such as a CLI bump, ride in the upgrade PR.

## Analyze

`pnpm cella analyze` leaves your files and branches alone. It lists files in the order they need you: what merges on its
own (`behind`, `diverged`), then pinned files, drifted files, and the upstream changes the upgrade leaves out. Large
groups collapse into a row per folder or kind, and `--all` lists every path.

Analyze and upgrade both end with `next steps`, numbered in the order you take them:

```
next steps
────────────────────────────────────────────────────────────

  1 review   file:///Users/you/app/.git/cella-diff/analyze-review.html
             22 diffs in 3 sections · 42 listed without a diff
  2 upgrade  pnpm cella upgrade
             merges on a fresh branch and stops for review · 36 update, 2 merge
  3 align    1 alignment arrives with this upgrade
             ○ Migration notes become alignments · manual · not breaking
             after the upgrade: pnpm cella align
```

Both commands mark each file with its status:

| Symbol | Label       | Meaning                                                                                                                    | Action                                                                    |
| :----: | ----------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
|   ◇    | `managed`   | Package/config file changed                                                                                                | Handled separately by cella                                               |
|   ⨂    | `ignored`   | Protected by ignored config                                                                                                | Excluded from upgrades                                                    |
|   ✓    | `identical` | App matches upstream                                                                                                       | No action needed                                                          |
|   ↑    | `ahead`     | App changed (pinned), upstream did not                                                                                     | Protected, keeping app                                                    |
|   !    | `drifted`   | App changed, not protected                                                                                                 | At risk, consider pinning                                                 |
|   ↓    | `behind`    | Upstream changed, app did not                                                                                              | Will update from upstream; a pinned file keeps the app copy (masking pin) |
|   ⇅    | `diverged`  | Both sides changed                                                                                                         | Will merge from upstream                                                  |
|   ⨀    | `pinned`    | Pinned and both changed (a deletion counts), moved upstream from a protected path, or edited by the app and moved into one | Protected, keeping app: review, see below                                 |
|   →    | `renamed`   | Upstream moved a file the app left unchanged from an unprotected path                                                      | Takes upstream's copy at the new path                                     |
|   ✗    | `deleted`   | App deleted it                                                                                                             | Stays deleted                                                             |
|   +    | `local`     | Only in app, never in upstream                                                                                             | No action needed                                                          |

### Protected but behind

A pinned or ignored file wins whole: when upstream also changed it since the last upgrade, upstream's change is dropped,
not merged. A pinned stylesheet can then miss utilities that merged components use. `analyze` lists such files under
`⚠ protected but behind upstream` with the lines upstream changed, and `upgrade` prints the same list in its summary.

A drop in an earlier upgrade shows as plain `ahead`. For that case `analyze` counts the `upstream lines absent` from
each pinned file. `upgrade --unpinned` lifts the pins for one run and merges the full upstream history, which brings
earlier drops back too: review the staged merge and keep what you want. `analyze --unpinned` previews it.

### Upstream changes that never merge

Two more kinds of upstream change never reach the app on their own, and both commands report them:

- **Ignored paths changed upstream**, which no conflict marks. New config keys under `shared/config` show up here.
- **Upstream's CLI config.** `cella/cella.config.ts` never merges. The report names each entry upstream added to,
  dropped from or renamed in its `pinned`, `ignored` or `packageJsonKeys`. `upgrade` stops before a new merge until you
  adopt the entries that fit your app and commit, or pass `--keep-config`.

### Review page

The review page shows the listed files' diffs side by side in your browser, under the same section titles. A diff shows
what upstream changed since the last upgrade, except in `arrived and decides what runs` (the staged merge),
`protected in app` (the app against upstream now) and `drifted` (what the app changed). `upgrade` opens it at the stop
for review. It lives in the git directory, and each run overwrites it.

## Package.json merge

`packageJsonKeys` names the package.json sections that merge from upstream, and `false` merges no package.json at all.
Each section merges three-way against the package.json of your last upgrade:

- An entry your app never touched follows upstream: it is added, updated or removed.
- An entry your app added or changed stays; only a strictly higher upstream version still bumps it, never in `scripts`.
- An entry your app removed is not re-added.
- A dependency or script upstream dropped stays while your own code still uses it, with a warning.
- `exports` are add-only and merge only when both sides are subpath maps.
- A workspace upstream added arrives with its package.json as upstream has it.

`type` always merges: it follows upstream where your app kept the previous value. Set it yourself to keep your own.

## Alignments

The app lists the alignments it has not handled in `cella/cella.alignments.json`: the upgrade adds the ones that arrive,
`align mark` removes them, and no file means none are pending. Alignments never block an upgrade. The upgrade PR lists
the open ones, and they stay listed until marked. What an alignment holds and what its frontmatter says:
[cella/alignments](https://github.com/cellajs/cella/blob/main/cella/alignments/README.md).

`align show <id>` adds the upstream commit and PR that brought the alignment, the files of that commit the app pins,
ignores or changed, and the app lines that hold a `grep` term. `align run <id>` runs the codemod with `tsx` from your app
root, report-only unless arguments follow `--`. A file that was identical to upstream gets upstream's content back after
the run: a codemod creates no drift.

## Adopt from forks

The template can pull changes from local forks and adopt them file by file. List your local forks in `cella.config.ts`:

```typescript
forks: [
  { name: 'raak', localPath: '../raak', pullBranch: 'main' },
],
```

`pnpm cella adopt` asks for a fork, fetches its `pullBranch` and builds a local `contrib/<fork>` branch with only that
fork's contributed files. Press `d` on a file to open its diff in your browser. Accepted files are checked out from the
contrib branch and staged for review. Nothing of the fork runs.
