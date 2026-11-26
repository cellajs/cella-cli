import { services as composeServices, type ServiceName } from '../compose/compose';
import type { ServiceMeta } from '../compose/types';
import type { EngineConfig, EngineServiceEndpoint } from './engine-config';

/** One deployable service: the Compose model's `x-service` (`ServiceMeta`) narrowed to this app's slug. Field meanings live on `ServiceMeta` in `../compose/types.ts`. */
export interface ServiceDefinition extends ServiceMeta {
  slug: ServiceName;
}

/** Ordered service definitions, derived from the typed Compose model. */
export const services = composeServices as readonly ServiceDefinition[];

/** Ordered service slugs: the canonical list every consumer derives from. */
export const serviceNames = services.map((s) => s.slug);

/** Lookup a service definition by slug. */
export const servicesByName = new Map<ServiceName, ServiceDefinition>(services.map((s) => [s.slug, s]));

/** Services enabled for an app. Enabled by default; an entry opts out with `{ enabled: false }`. Compute and the load balancer both derive from this list. */
export function enabledServices(serviceConfig: Record<string, EngineServiceEndpoint>): readonly ServiceDefinition[] {
  return services.filter((s) => serviceConfig[s.slug]?.enabled !== false);
}

/** A service list split by singleVM placement: `vm` gets a machine of its own, `coHosted` folds into the host process, `collocated` runs as a container beside the host. Without singleVM everything is `vm`. */
export interface PlacedServices {
  vm: readonly ServiceDefinition[];
  coHosted: readonly ServiceDefinition[];
  collocated: readonly ServiceDefinition[];
}

/**
 * Apply singleVM placement to a service list: which services get a machine of their own, which fold into the host process and which run as
 * a container beside it.
 */
export function placeServices(definitions: readonly ServiceDefinition[], singleVM: boolean): PlacedServices {
  if (!singleVM) return { vm: definitions, coHosted: [], collocated: [] };
  const collocated = definitions.filter((s) => s.placement === 'host');
  for (const svc of collocated) {
    if (svc.primaryRollout)
      throw new Error(`services: '${svc.slug}' cannot combine placement 'host' with primaryRollout (the host cannot collocate onto itself).`);
    if (svc.coHosted)
      throw new Error(
        `services: '${svc.slug}' cannot set both coHosted and placement 'host': in-process fold and container collocation are mutually exclusive.`,
      );
  }
  const vm = definitions.filter((s) => !s.coHosted && s.placement !== 'host');
  const coHosted = definitions.filter((s) => s.coHosted);
  return { vm, coHosted, collocated };
}

/** Enabled services that get a machine of their own. singleVM drops co-hosted workers and host-collocated containers from the machines while keeping their routing through the host target. */
export function deployedServices(serviceConfig: Record<string, EngineServiceEndpoint>, singleVM: boolean): readonly ServiceDefinition[] {
  return placeServices(enabledServices(serviceConfig), singleVM).vm;
}

/** The services one machine carries: its own, and on the singleVM host every co-hosted worker and collocated container. */
export function carriedServices(
  serviceConfig: Record<string, EngineServiceEndpoint>,
  singleVM: boolean,
  machine: ServiceDefinition,
): readonly ServiceDefinition[] {
  if (!singleVM || !machine.primaryRollout) return [machine];
  const placed = placeServices(enabledServices(serviceConfig), singleVM);
  return [machine, ...placed.coHosted, ...placed.collocated];
}

/**
 * The object storage implied by the service registry: the SPA bucket follows the default-route service, the upload buckets follow any `s3Access` service, and browser CORS exists only when both do.
 * Engine-owned buckets (Pulumi state, boot-diag) are unconditional and absent here, so a registry with neither a default route nor an s3Access service provisions no app buckets.
 */
export function appStorageNeeds(definitions: readonly ServiceDefinition[]): {
  spaBucket: boolean;
  uploadBuckets: boolean;
  browserOriginSlug?: ServiceName;
} {
  const browserOriginSlug = definitions.find((s) => s.lbRoute === 'default')?.slug;
  const spaBucket = browserOriginSlug !== undefined;
  const uploadBuckets = definitions.some((s) => s.s3Access);
  return { spaBucket, uploadBuckets, browserOriginSlug };
}

/** A public service's resolved endpoint, derived from appConfig by the registry. */
export interface ServiceEndpoint {
  slug: ServiceName;
  /** Full public URL from appConfig (e.g. `https://api.example.com`). */
  url: string;
  /** Hostname only (e.g. `api.example.com`), for DNS records, certs, LB routes. */
  host: string;
}

/**
 * Per-service public endpoints from appConfig. A service has an endpoint only when it declares an `lbRoute`; internal-only services are omitted.
 * Must stay a function taking the resolved appConfig: this module is imported before APP_MODE is set, so it can never read appConfig at module level.
 */
export function serviceEndpoints(cfg: EngineConfig): readonly ServiceEndpoint[] {
  return services
    .filter((s) => s.lbRoute)
    .map((s) => {
      const url = cfg.services[s.slug]?.publicUrl;
      if (!url) throw new Error(`Public service '${s.slug}' (lbRoute set) has no URL in appConfig`);
      return { slug: s.slug, url, host: new URL(url).hostname };
    });
}
