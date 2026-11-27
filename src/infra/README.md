# Deploy engine

The engine behind `pnpm cella infra`: it sets up a cella app on [Scaleway](https://www.scaleway.com/) with [Pulumi](https://www.pulumi.com/docs/) and deploys its releases.

What an operator does with it, how a release flows, the status checks and the vocabulary are in the template's [Infra CLI guide](https://github.com/cellajs/cella/blob/main/cella/infra/README.md), which the docs site shows.

## How an app runs it

- **The app's part** is its `cella/infra/` folder, a plain folder with no package of its own: the [description](#the-description), the Pulumi project, the stack files and the environment records. The app root is the working directory, or two folders up when that is `cella/infra`, where Pulumi runs the program. A root without `cella/infra/description.yml` is refused, and so is one that keeps its infra in `infra/`, with the alignment that moves it. Pulumi, the Scaleway provider and the S3 SDK are peers, which the app's `cella/package.json` pins with the engine: the app's `cella` folder is a workspace package, and Pulumi in `cella/infra` resolves them there.
- **Commands**: `pnpm cella infra` opens the infra CLI. A first word that names a task, such as `main-job` or `description-hash`, runs that task: the engine image, the builder, CI and the engine itself start a task by the engine's bin in `cella/node_modules/.bin`, with `infra <task>`, from the app root. Two tasks are for a person to read. `pnpm cella infra compose` prints the Compose file a deploy renders. `pnpm cella infra description --mode <production|staging>` prints the app as the engine of that environment sees it, indented: the text the applied description's hash is taken of, which `description-hash --json` prints on one line.
- **Exports**: `@cellajs/cli/infra/program` is the Pulumi program an app's `program.mjs` hands over to. `@cellajs/cli/infra/contract` holds what an app's own tests check its files against, the tasks a person runs among it. `@cellajs/cli/infra/description.schema.json` is the description's JSON Schema.
- **Build files**: the package ships the engine image's Dockerfile and the agent's and the frontend proxy's build folders under `dist/infra-assets`, the agent bundled. The builder stages them before it bakes.

## The description

`cella/infra/description.yml` states what only a deployment knows: the services, the runtime secrets, the stores, the managed keys, the general settings and the env keys that select which service a container runs. The schema is strict. An unknown key, a wrong type or a broken rule stops the load, and the message names the key's path.

The engine reads it in two stages. One process serves one mode, and the app's `appConfig` is built once, when a module of its `shared` first loads. The CLI's menus and several engine modules read the services and the secrets before the mode is known. The file stage serves them: it reads the file and imports nothing of the app. The app stage loads once the mode is set, imports `appConfig` and refuses a port or path the file states otherwise.

A **reference** names an export of an app file as `'<path from the app root>#<export>'`, the path under `shared/` or `cella/infra/`: the engine image holds those two folders alone. A derived secret's `with` names the function that turns its source's value into its own, and the proxy service's `headers` names its CSP, embed CSP and Permissions-Policy. The app stage refuses a missing file or export and a value of the wrong kind.

A service's `dockerfile` is `engine:proxy`, the engine's frontend proxy, or a path inside the app with no leading `/` and no `..` segment. An `env` value is literal or holds `@{<service>.<property>}` for a value the engine fills. It takes no `$`, which Compose would interpolate, and no `#` after whitespace, where a machine's env file ends it. The load refuses a slug, an env key or a managed key's suffix the engine uses itself, naming what uses it.

A generated secret states its `secretName`, the container that keeps its value: another name would make a new container with a new value. The applied description holds what each derivation answers for a fixed probe input: a change to the function, or to what it calls, owes an apply. A derivation is a pure function of any string. One that throws on the probe stops every task, and one that answers otherwise on each call owes an apply every time.

### In an editor

An editor validates the file against the JSON Schema with a first line such as `# yaml-language-server: $schema=../node_modules/@cellajs/cli/dist/infra-description.schema.json`. The schema holds the structure, the key patterns and the enums.

The load alone checks the rules across fields and entries: the proxy's `headers`, which of `generation`, `rotatable`, `required` and `derivedFrom` go together, a generated secret's `secretName`, the services and secrets an entry names, unique ids and stored names, reserved names, the schedule, and the comparison with `appConfig`. A file the editor accepts can still fail the load: the engine has the last word.

## File map

| Path                                                 | Holds                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [command.ts](command.ts), [run.ts](run.ts)           | The `infra` command, and the hand-over to a task or the infra CLI                                       |
| [contract.ts](contract.ts), [program.ts](program.ts) | The package's two infra code exports                                                                    |
| [cli/](cli/)                                         | The menu and its actions                                                                                |
| [resources/](resources/)                             | The Pulumi program: the foundation, no machine                                                          |
| [tasks/](tasks/README.md)                            | The deploy's steps and the operator tasks                                                               |
| [lib/description/](lib/description/)                 | The description's schema and its two stages                                                             |
| [lib/](lib/)                                         | What they share                                                                                         |
| [compose/](compose/)                                 | The Compose model, rendered in memory from the description's services                                   |
| [agent/](agent/)                                     | The agent every machine runs                                                                            |
| [caddy/](caddy/)                                     | The frontend's Caddy image and its Caddyfile                                                            |
| [Dockerfile](Dockerfile)                             | The engine image an apply builds                                                                        |
| [tests/](tests/README.md)                            | Tests that span modules, their helpers, and the fixture app: a description and a production `appConfig` |

Its history before the move is in the template's: `git log -- infra/` in [cella](https://github.com/cellajs/cella).
