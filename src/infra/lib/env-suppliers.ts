import type { ProxyHeaders } from './description/schema';
import type { EngineConfig } from './engine-config';
import type { InfraDerivations } from './naming';

/** What a supplier may read: the environment's engine config, names, region and mode, and each public service's URL. */
export interface EnvSupplierContext {
  config: EngineConfig;
  naming: InfraDerivations['naming'];
  region: string;
  mode: string;
  /** Full public URL of a service that declares an LB route; throws for an internal one. */
  serviceUrl(slug: string): string;
}

/** A supplier for one compose `${VAR}` placeholder, called when a deploy writes a machine's static env. */
export type EnvSupplier = (ctx: EnvSupplierContext) => string;

/** How the engine supplies each variable of the frontend proxy's env: a header value of the app's `headers`, or the frontend bucket's host. */
const proxySupply = {
  FRONTEND_CSP: (headers) => headers.csp,
  FRONTEND_EMBED_CSP: (headers) => headers.embedCsp,
  FRONTEND_PERMISSIONS_POLICY: (headers) => headers.permissionsPolicy,
  ORIGIN_HOST: (_headers, { naming, region }) => `${naming.frontendBucket}.s3.${region}.scw.cloud`,
} satisfies Record<string, (headers: ProxyHeaders, ctx: EnvSupplierContext) => string>;

/** The variables the engine supplies to the frontend proxy's env. */
export const proxyEnvNames: readonly string[] = Object.keys(proxySupply);

/**
 * The variables the engine sets, each with what sets it. No `env` or `release.env` of the description holds one: a binding there beats
 * the engine's value in the static env file, which every container of the single-process host reads. `NODE_ENV` and `TZ` stay the app's.
 */
const engineVariables: readonly [name: string | RegExp, setBy: string][] = [
  ...proxyEnvNames.map((name): [string, string] => [name, "the engine's frontend proxy"]),
  ['REGISTRY', 'the static env: the registry the release images are named for'],
  ['APP_MODE', "the static env and each service's standard env: the mode"],
  ['RELEASE_SHA', 'the image build: the release each image reports'],
  [/_TAG$/, "the static env: a service's release tag"],
  [/^AGENT_/, "the static env and the machine's launcher: the agent's image, tag and folder"],
];

/** What sets a variable the engine owns; undefined for a variable the app may set. */
export const engineVariableSetter = (name: string): string | undefined =>
  engineVariables.find(([match]) => (typeof match === 'string' ? match === name : match.test(name)))?.[1];

/**
 * The engine's suppliers for the frontend proxy's env, from the header values the app stage read.
 * @returns no supplier without header values: the app runs no engine proxy
 */
export function proxyEnvSuppliers(headers: ProxyHeaders | undefined): Record<string, EnvSupplier> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(proxySupply).map(([name, supply]) => [name, (ctx: EnvSupplierContext) => supply(headers, ctx)]));
}
