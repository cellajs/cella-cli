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

/** The variables the engine supplies to the frontend proxy's env, which no service of the description may set. */
export const proxyEnvNames: readonly string[] = Object.keys(proxySupply);

/**
 * The engine's suppliers for the frontend proxy's env, from the header values the app stage read.
 * @returns no supplier without header values: the app runs no engine proxy
 */
export function proxyEnvSuppliers(headers: ProxyHeaders | undefined): Record<string, EnvSupplier> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(proxySupply).map(([name, supply]) => [name, (ctx: EnvSupplierContext) => supply(headers, ctx)]));
}
