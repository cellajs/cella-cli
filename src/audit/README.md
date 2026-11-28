# Audit

`pnpm cella audit` reports the outdated packages, the runtime pins, the tools on this machine and the security plan,
then asks whether to update. `pnpm cella audit fix` works in two layers, in this order:

1. **Updates.** It lists the outdated packages and runtime pins in one table and asks once which to update. Rows with a
   high or critical advisory start ticked; submitting with nothing ticked skips this layer.
2. **Security.** It audits the workspace as the picked updates leave it and brings three settings in
   `pnpm-workspace.yaml` in line with that audit.

Everything is written at the end with one `pnpm install`, and cancelling any prompt leaves the workspace as it was.
Outside a git repository the audit finds no Dockerfile, and only the image pins go unread.

## Runtime pins

The audit checks the runtimes the workspace pins to an exact version, which `pnpm audit` never sees, against their own
release feeds:

| Pin                                            | Feed                                   | Dot                                                             |
| ---------------------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| root `engines.node`                            | nodejs.org release index               | red when a newer release in the line is a security release      |
| root `packageManager` (pnpm)                   | npm registry and its advisory database | red when the newer version fixes an advisory on yours           |
| `FROM image:2.8-suffix` in tracked Dockerfiles | Docker Hub tags                        | yellow when your tag has gone stale while a newer one is pushed |

A pin moves within its major, to the newest version older than `minimumReleaseAge`. A Node bump waits until Docker Hub
has the `node:<version><suffix>` images the Dockerfiles build from, and the audit prints what is left to do on your
machine: switching its Node, and building each changed image.

## This machine

The pins say what the workspace should run; the tools on your machine can still miss security fixes. Below the table the
audit shows what each one misses: the Node running the audit, the pnpm your terminal starts before it switches to
`packageManager`, and the `gh` on your PATH. A tool that misses a fix gets the command that fixes it for the way it was
installed (Volta, Homebrew, or pnpm's own `self-update`). The audit does not change these tools itself.

## Security overrides

The security layer treats its overrides as output, not as configuration. Every run drops them, resolves the workspace
without them in a temporary copy, and puts back only the ones a current advisory still needs. The workspace changes
once, at the end, and only when the outcome differs from what is there.

| Setting                    | What the audit owns                                                              | What it leaves alone                                           |
| -------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `overrides`                | keys with a version selector: `pkg@<1.2.3`                                       | keys without one (`pkg`) and parent-scoped keys (`parent>pkg`) |
| `minimumReleaseAgeExclude` | `pkg@1.2.3` entries, removed once that version is older than `minimumReleaseAge` | name-only entries                                              |
| `auditConfig.ignoreGhsas`  | every entry, removed when the advisory no longer applies or a fix arrives        |                                                                |

For each advisory the audit looks up the published versions itself; it does not trust the patched version an advisory
claims. Most outcomes need no answer from you:

- **A fix that fits.** The audit writes an override. When the fix lies inside the range the parents ask for, the
  lockfile holds the fixed version on its own, and the following run drops the override.
- **A breaking fix** (another major, or another minor below 1.0), or a fix for a package you depend on directly: you
  choose between leaving it open, applying the override and ignoring the advisory. An override that was in place before
  the run is applied again without asking.
- **A fix younger than `minimumReleaseAge`**: you choose between waiting and installing it now with an exclude.
- **No fix published**: you are asked whether to ignore the advisory until one is.
