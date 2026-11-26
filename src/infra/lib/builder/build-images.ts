import { basename, dirname } from 'node:path';
import { pinnedNodeImage } from '../deploy/node-image';
import { agentImageName } from '../deploy/release-archives';
import { engineAssets } from './builder-machine';

// The bake definition the builder machine runs: targets derive from the deploy's build matrix, and each image is written as an archive.

export interface BuildImageRow {
  service: string;
  dockerfile: string;
  /** The stage of a multi-stage Dockerfile: without it every image of that file would be its last stage. */
  target?: string;
}

export interface BakeOptions {
  registry: string;
  namespace: string;
  /** The release sha: every image's tag and its `RELEASE_SHA`. */
  releaseSha: string;
  /** The root package.json `engines.node`: every image's `FROM` takes the `node` image at it by digest, as `NODE_IMAGE`. */
  nodeVersion: string;
  /** Path of the build context relative to the bake process cwd (the repo root). */
  context?: string;
  /** The folder each image's archive is written to, as `<name>.tar`. */
  archiveDir: string;
}

/**
 * A `docker buildx bake` definition covering every app image and the agent, in two groups: `services` bakes while the release's
 * workspace installs, `engine` after it, with the agent and every image whose Dockerfile is one of the engine's. Each image is written to `<archiveDir>/<name>.tar` in the format `docker load` reads, tagged as the release's
 * compose file names it, and pushed nowhere.
 */
export function bakeDefinition(rows: BuildImageRow[], opts: BakeOptions): { group: unknown; target: Record<string, unknown> } {
  const context = opts.context ?? '.';
  const image = (name: string) => `${opts.registry}/${opts.namespace}/${name}:${opts.releaseSha}`;
  const archive = (name: string) => [`type=docker,dest=${opts.archiveDir}/${name}.tar`];
  const target: Record<string, unknown> = {};
  for (const row of rows) {
    const fromEngine = row.dockerfile.startsWith(`${engineAssets}/`);
    target[row.service] = {
      // An engine Dockerfile copies what lies beside it
      context: fromEngine ? dirname(row.dockerfile) : context,
      dockerfile: fromEngine ? basename(row.dockerfile) : row.dockerfile,
      ...(row.target ? { target: row.target } : {}),
      tags: [image(row.service)],
      args: { RELEASE_SHA: opts.releaseSha, NODE_IMAGE: pinnedNodeImage(opts.nodeVersion, 'alpine') },
      output: archive(row.service),
    };
  }
  target.agent = {
    context: `${engineAssets}/agent`,
    dockerfile: 'Dockerfile',
    tags: [image(agentImageName)],
    args: { NODE_IMAGE: pinnedNodeImage(opts.nodeVersion, 'bookworm-slim') },
    output: archive(agentImageName),
  };
  const services = rows.filter((row) => !row.dockerfile.startsWith(`${engineAssets}/`)).map((row) => row.service);
  const engine = [...rows.filter((row) => !services.includes(row.service)).map((row) => row.service), 'agent'];
  return {
    group: { default: { targets: [...services, ...engine] }, services: { targets: services }, engine: { targets: engine } },
    target,
  };
}
