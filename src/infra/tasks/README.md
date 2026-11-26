# tasks

The deploy's steps and the operator tasks. Each sequencer takes its live effects as arguments: `geoip-refresh` and `reset-database` as functions on their plan, `deploy-run`, `build-release`, `switch-machines`, `clear-machine-links` and `main-job` as an effects object beside it. Unit tests pass fakes and assert step order and every guard.

- **Deploy steps**: [main-job.ts](./main-job.ts) finds a scheduled run's target and ends the run when that target has a record, checks a releases-only target against the release tags and runs [deploy.ts](./deploy.ts), and [deploy-run.ts](./deploy-run.ts) runs the steps in order on the table `deploy-env.ts` builds: the lease, the live record, the engine check, `compose-env` with `check` (the required values are stored), `build-release`, the description check, `compose-env` (each role's env file), `geoip-refresh`, the switches, `clear-machine-links` and `smoke`.
- **Build**: `build-release` makes the builder machine, from `build-images` (the image bake into archives) and `frontend-build-env`, then uploads the frontend files from their archive with `frontend-assets`, whose prune after the publish deletes the hashed files no release that served within the retention lists. `print-builder-script` prints the builder's frontend or agent script for a run outside a deploy, as CI's frontend build does.
- **Switch**: `switch-machines` switches each role to its new machine, the primary first; `wait-for-version` reads the pools until an address serves or drained.
- **Apply and operator tasks**: `ensure-state-bucket` (the setup's state bucket), `publish-engine` (the engine image and `applied.json`), `description-hash` (what the apply records and a builder reports), `ensure-database`, `ensure-secrets`, `seed-operator-secrets`, `verify-after-apply`, `repair-certs`, `manage-runtime-secrets`, `reset-database` and `final-dump` (the database into the boot-diag bucket before a teardown).
- **Identity tasks**, written at an Owner moment: `declared-policies`, `uploads-key`, `setup-ci-key`, `setup-operators`, `setup-observer-app`, `provision-managed-key`, `transloadit-key`; `identity-plan` reads where the identities differ from the declared ones.
- **Pull request checks**: `privileged-check` renders the base and the head with `privileged-footprint`; `release-applied-check`, on the release PR, holds the head's `description-hash` against the one the last apply published.
- **Status**: `status`, the report behind `pnpm cella infra status`.

## Failing a task

A task that [deploy-run.ts](./deploy-run.ts) runs in-process reports failure by throwing, never through `process.exit` or `process.exitCode`: the deploy stops only on a throw. A task whose exit code means something to a standalone caller (exit 2, blocked: the env composition for a missing required secret) throws `ExitCodeError` ([lib/utils/errors.ts](../lib/utils/errors.ts)), and `runTask` ([run.ts](../run.ts)) and [deploy.ts](./deploy.ts) exit with its code.
