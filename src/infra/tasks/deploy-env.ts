import type { BuildImageRow } from '../lib/builder/build-images';
import type { EngineConfig } from '../lib/engine-config';
import { machineRoles } from '../lib/machine-roles';
import { deriveInfra, redirectedApexOrigin } from '../lib/naming';
import { appStorageNeeds, enabledServices, serviceEndpoints } from '../lib/services';

/** One enabled service as the deploy's build, frontend build and smoke tests read it; an absent value is ''. */
export interface EnabledServiceRow {
  service: string;
  public_url: string;
  health_url: string;
  lb_route: string;
  dockerfile: string;
  reuses_image_of: string;
  primary_rollout: boolean;
}

/** The deploy env table: one string per key, but the enabled services and the images to build. */
export interface DeployEnv {
  stack: string;
  region: string;
  frontend_bucket: string;
  public_bucket: string;
  diag_bucket: string;
  enabled_services: EnabledServiceRow[];
  build_images: BuildImageRow[];
  primary_role: string;
  apex_url: string;
}

/** Pure builder that produces the deploy env table from an appConfig. */
export function buildDeployEnv(appConfig: EngineConfig): DeployEnv {
  const { naming, dnsZone } = deriveInfra(appConfig);
  const enabled = enabledServices(appConfig.services);
  const serviceUrls = appConfig.services as Record<string, { publicUrl?: string }>;
  const serviceUrl = (slug: string): string => serviceUrls[slug]?.publicUrl ?? '';
  const urls = new Map(serviceEndpoints(appConfig).map((endpoint) => [endpoint.slug, endpoint.url]));
  const enabledServiceRows = enabled.map(
    (service): EnabledServiceRow => ({
      service: service.slug,
      public_url: serviceUrl(service.slug),
      health_url: service.lbRoute ? (urls.get(service.slug) ?? '') : '',
      lb_route: service.lbRoute ?? '',
      dockerfile: service.dockerfile ?? '',
      reuses_image_of: service.reusesImageOf ?? '',
      primary_rollout: service.primaryRollout === true,
    }),
  );
  const defaultRoute = enabled.find((service) => service.lbRoute === 'default');
  const defaultRouteUrl = defaultRoute ? serviceUrl(defaultRoute.slug) : '';
  const buildImages = enabled
    .filter((service) => !service.reusesImageOf)
    .map((service): BuildImageRow => {
      if (!service.dockerfile) throw new Error(`Service '${service.slug}' builds its own image but has no dockerfile in infra/description.yml`);
      return { service: service.slug, dockerfile: service.dockerfile, target: service.target ?? '' };
    });

  return {
    stack: appConfig.mode,
    region: appConfig.s3.region,
    // Empty when the registry implies no SPA bucket (frontend-less app); the deploy skips asset upload + entry publish on ''.
    frontend_bucket: appStorageNeeds(enabled).spaBucket ? naming.frontendBucket : '',
    public_bucket: appStorageNeeds(enabled).uploadBuckets ? naming.publicBucket : '',
    diag_bucket: naming.bootDiagBucket,
    enabled_services: enabledServiceRows,
    build_images: buildImages,
    primary_role: machineRoles(appConfig).find((role) => role.primary)?.role ?? '',
    // The zone apex the load balancer redirects to the app host, for smoke's apex checks; empty when that host is no `www.<zone>`.
    apex_url: defaultRouteUrl ? (redirectedApexOrigin(new URL(defaultRouteUrl).hostname, dnsZone) ?? '') : '',
  };
}
