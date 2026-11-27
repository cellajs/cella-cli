# infra tests: where a test file lives

## Co-located `*.test.ts` (next to the module): the default

A test that imports **one** module and exercises its exported behaviour lives beside that module (`lib/**`, `tasks/**`, `agent/src/**`, `cli/**`, `compose/**`).

Modules under `resources/` construct live Pulumi resources at import time, so their co-located test primes the mock runtime and dynamic-imports the module. It is still a single-module test and lives beside the source (`resources/loadbalancer.test.ts`, `resources/network.test.ts`, `resources/stores/*.test.ts`).

## `tests/`: everything cross-cutting

- **`tests/unit/`**: tests without a single owning module. Source-shape checks that read a file as text (`no-unexpected-public`, `resource-contracts`, `engine-config`, `operator-actions`, `caddyfile`), and rules that span modules (`managed-keys`, `internal-port`, `path-prefix`, `dns-cert-gates`).
- **`tests/helpers/`**: shared fixtures and the Pulumi mock harness. Not tests.
- **`tests/fixtures/`**: control records as a release wrote them, one folder a release, which `tests/unit/older-engine-records` reads with today's readers. A folder is never edited.
- **`tests/fixtures/app/`**: the app root every test runs in ([setup.ts](setup.ts)): its `infra/description.yml`, the `shared` modules the description names, an `appConfig` snapshot of production and the root `package.json`. It is a frozen test app, not a copy that follows the template: change it only when a test needs it.
