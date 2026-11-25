# Deploy engine

The engine behind `pnpm cella infra`: it sets up a cella app on [Scaleway](https://www.scaleway.com/) with [Pulumi](https://www.pulumi.com/docs/) and deploys its releases.

What an operator does with it, how a release flows, the status checks and the vocabulary are in the template's [Infra CLI guide](https://github.com/cellajs/cella/blob/main/infra/README.md), which the docs site shows.

## How an app runs it

- **The app's part** is its `infra` workspace: the registries under `config/`, the stack files and the environment records. The package takes that workspace as an optional peer named `infra`, and the engine reads the registries as `infra/config/<file>`. Pulumi, the Scaleway provider and the S3 SDK are peers too, at the versions the app's workspace pins.
- **Commands**: `pnpm cella infra` opens the infra CLI. A first word that names a task, such as `main-job` or `description-hash`, runs that task: the app's `infra` scripts, the engine image, the builder and CI call tasks by these names.
- **Exports**: `@cellajs/cli/infra` holds what an app's config calls (the define helpers, `defineEngineConfig`, the store catalog). `@cellajs/cli/infra/program` is the Pulumi program an app's `program.mjs` hands over to. `@cellajs/cli/infra/contract` holds what an app's own tests check its files against.
- **Build files**: the package ships the engine image's Dockerfile and the agent's and the frontend proxy's build folders under `dist/infra-assets`, the agent bundled. The builder stages them before it bakes.

## File map

| Path                                                                           | Holds                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [command.ts](command.ts), [run.ts](run.ts)                                     | The `infra` command, and the hand-over to a task or the infra CLI                                             |
| [exports.ts](exports.ts), [contract.ts](contract.ts), [program.ts](program.ts) | The package's three infra exports                                                                             |
| [cli/](cli/)                                                                   | The menu and its actions                                                                                      |
| [resources/](resources/)                                                       | The Pulumi program: the foundation, no machine                                                                |
| [tasks/](tasks/README.md)                                                      | The deploy's steps and the operator tasks                                                                     |
| [lib/](lib/)                                                                   | What they share                                                                                               |
| [compose/](compose/)                                                           | The Compose model, assembled from the app's service registry into its `compose.gen.yml`                       |
| [agent/](agent/)                                                               | The agent every machine runs                                                                                  |
| [caddy/](caddy/)                                                               | The frontend's Caddy image and its Caddyfile                                                                  |
| [Dockerfile](Dockerfile)                                                       | The engine image an apply builds                                                                              |
| [tests/](tests/README.md)                                                      | Tests that span modules, their helpers, and the fixture app: the template's config with its production values |

Its history before the move is in the template's: `git log -- infra/` in [cella](https://github.com/cellajs/cella).
