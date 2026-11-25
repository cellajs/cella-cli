/** One service's endpoint entry in the app config (`services.<slug>`). */
export interface EngineServiceEndpoint {
  enabled?: boolean;
  publicUrl?: string;
}

/** The engine's input contract: everything the deploy engine reads about the app. Any new field the engine reads belongs here first, and in the applied description (lib/deploy/app-description.ts). */
export interface EngineConfig {
  /** URL-safe resource prefix for every Scaleway resource and bucket. */
  slug: string;
  /** The app's own slug, the same in every environment: it names what the app has one of, the operator and the observer. */
  appSlug: string;
  /** Config mode; deploys accept 'production' or 'staging'. */
  mode: string;
  /** Registered DNS zone the app deploys under ('localhost' disables deploys). */
  domain: string;
  frontendUrl: string;
  backendUrl: string;
  /** Cost escape hatch: the backend co-hosts every enabled worker in-process. */
  singleVM: boolean;
  s3: {
    region: string;
    host: string;
    publicBucketName: string;
    privateBucketName: string;
    publicCDNUrl: string;
    privateCDNUrl: string;
  };
  /** Service endpoint config keyed by slug (enabled flags + public URLs). */
  services: Record<string, EngineServiceEndpoint>;
  /** Switches the frontend CSP reads: an LTI platform frames LTI tools. */
  has: { ltiPlatform: boolean };
  /** The LTI platform origins the CSP of a document under `/embed/` lets frame it. */
  ltiFrameAncestors: string[];
  /** Contact-map style URLs per color mode; the frontend CSP allows their origins. */
  mapStyleUrls?: Record<string, string>;
  retention: { backupDays: number };
}

/**
 * The slug namespaces every Scaleway resource name, a machine's `/etc/<slug>` config dir, and the `::<slug>::` serial
 * marker of its first-boot script (lib/deploy/machine-user-data.ts). Pinning it to kebab-case at the config boundary
 * makes every downstream shell use of the slug safe by construction, so no call site needs its own quoting or escaping.
 */
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `engine-config: slug '${slug}' must be lowercase kebab-case (letters, digits, hyphens; leading letter). It namespaces machine paths and shell markers.`,
    );
  }
}

/**
 * The app's config as the engine deploys it, checked once: an app keeps its own fields beside the contract's.
 * @throws when the slug or the app's slug is not lowercase kebab-case
 */
export function defineEngineConfig<Config extends EngineConfig>(config: Config): Config {
  assertValidSlug(config.slug);
  assertValidSlug(config.appSlug);
  return config;
}
