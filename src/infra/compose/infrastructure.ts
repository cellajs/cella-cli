import { healthContract } from '../lib/health-contract';
import type { AppServiceConfig, AppServices, ComposeFile, ComposeService, HealthCheck, ServiceMeta } from './types';

/**
 * A service's agent port, on which the machine's agent answers the load balancer's check for it, is its own port shifted by this: it moves
 * only with that port, so a registry change moves no other service's check.
 */
export const agentPortOffset = 5000;

/**
 * Checks a service registry's ports and path prefixes, which the description loader runs on the services it resolved.
 * @throws for an internal or agent port another service holds, or a path prefix that is malformed, unrouted or taken
 */
export function validateServices(services: AppServices): void {
  validateInternalPorts(services);
  validateAgentPorts(services);
  const seenPrefixes = new Map<string, string>();
  for (const [slug, cfg] of Object.entries(services)) {
    const prefix = cfg.pathPrefix;
    if (prefix === undefined) {
      if (cfg.lbRoute === 'path') throw new Error(`'${slug}' has lbRoute 'path' but no pathPrefix: nothing would route to it.`);
      continue;
    }
    // The LB matches the raw path-begin string, so a malformed prefix routes wrong traffic: validate at synth time.
    if (!cfg.lbRoute) throw new Error(`'${slug}' declares pathPrefix without lbRoute: an internal-only service has no LB backend to route to.`);
    if (!/^\/[a-z0-9-]+$/.test(prefix)) {
      throw new Error(
        `'${slug}' pathPrefix '${prefix}' must be a single lowercase path segment starting with '/' and no trailing slash (e.g. '/api').`,
      );
    }
    const owner = seenPrefixes.get(prefix);
    if (owner) throw new Error(`pathPrefix '${prefix}' declared by both '${owner}' and '${slug}': path prefixes must be unique.`);
    seenPrefixes.set(prefix, slug);
  }
}

/**
 * An internal listener must be a port of its own: sharing one with a public listener would let the public LB pool
 * reach the server-to-server routes, and a singleVM host publishes every service's ports side by side.
 */
function validateInternalPorts(services: AppServices): void {
  const owners = new Map<number, string>();
  for (const [slug, cfg] of Object.entries(services)) owners.set(cfg.port, slug);
  for (const [slug, cfg] of Object.entries(services)) {
    const port = cfg.internalPort;
    if (port === undefined) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`'${slug}' internalPort ${port} is not a valid port.`);
    const owner = owners.get(port);
    if (owner) throw new Error(`'${slug}' internalPort ${port} is also the port of '${owner}': an internal listener needs a port of its own.`);
    owners.set(port, slug);
  }
}

/** The static env, and the runtime one the agent fetches at the machine's first boot: optional, as Compose starts the agent before it exists. */
const envFiles = ['.env', { path: '.env.runtime', required: false as const }];

/** An agent port must be a port of its own: the single-process host publishes every service's ports beside its agent's. */
function validateAgentPorts(services: AppServices): void {
  const taken = new Map<number, string>();
  for (const [slug, cfg] of Object.entries(services)) {
    taken.set(cfg.port, slug);
    if (cfg.internalPort !== undefined) taken.set(cfg.internalPort, slug);
  }
  for (const [slug, cfg] of Object.entries(services)) {
    const port = cfg.port + agentPortOffset;
    const owner = taken.get(port);
    if (port > 65535 || owner) {
      throw new Error(`'${slug}' port ${cfg.port} puts its agent port on ${port}, ${owner ? `the port of '${owner}'` : 'outside the port range'}.`);
    }
  }
}

/** Standard environment injected into every app service unless opted out. */
const standardEnv = { NODE_ENV: 'production', APP_MODE: '${APP_MODE:-production}', TZ: 'UTC' } as const;

/** Uniform identity healthcheck injected into every app service. The interval floors how fast `compose up --wait` can observe readiness at boot (the agent's boot waits on it), so it stays short; `start_interval` would scope that to startup but needs a compose/engine version floor the marketplace machine image cannot guarantee. */
function healthcheck(port: number, startPeriod: string): HealthCheck {
  return {
    test: ['CMD', 'wget', '-qO-', `http://127.0.0.1:${port}${healthContract.path}`],
    interval: '5s',
    timeout: '5s',
    retries: 3,
    start_period: startPeriod,
  };
}

/** Build the `x-service` deploy metadata from an app service entry (omit absent optionals). */
function metaFrom(slug: string, cfg: AppServiceConfig): ServiceMeta {
  const meta: ServiceMeta = {
    slug,
    healthPort: cfg.port,
    runRelease: cfg.release !== undefined,
    replacementStrategy: cfg.replacementStrategy,
    drainSeconds: cfg.drainSeconds ?? 0,
    instanceType: cfg.instanceType,
  };
  if (cfg.primaryRollout) meta.primaryRollout = true;
  if (cfg.drainPolicy) meta.drainPolicy = cfg.drainPolicy;
  if (cfg.lbRoute) meta.lbRoute = cfg.lbRoute;
  if (cfg.pathPrefix) meta.pathPrefix = cfg.pathPrefix;
  if (cfg.lbWebsockets) meta.lbWebsockets = true;
  if (cfg.internalPort !== undefined) meta.internalPort = cfg.internalPort;
  if (cfg.reusesImageOf) meta.reusesImageOf = cfg.reusesImageOf;
  if (cfg.dockerfile) meta.dockerfile = cfg.dockerfile;
  if (cfg.target) meta.target = cfg.target;
  if (cfg.coHosted) meta.coHosted = true;
  if (cfg.placement) meta.placement = cfg.placement;
  if (cfg.s3Access) meta.s3Access = true;
  if (cfg.bindings) meta.bindings = cfg.bindings;
  return meta;
}

/** A container of an app service keeps only the capabilities it declares, and no exec grants it more. */
function privileges(cfg: AppServiceConfig): Pick<ComposeService, 'cap_drop' | 'cap_add' | 'security_opt'> {
  return {
    cap_drop: ['ALL'],
    ...(cfg.capabilities?.length ? { cap_add: cfg.capabilities } : {}),
    security_opt: ['no-new-privileges:true'],
  };
}

/** Expand one app service entry into a full Compose service block. */
function appBlock(slug: string, cfg: AppServiceConfig): ComposeService {
  const environment = {
    ...(cfg.includeStandardEnv === false ? {} : standardEnv),
    ...(cfg.env ?? {}),
  };
  const block: ComposeService = {
    image: cfg.image,
    pull_policy: 'never',
    profiles: [slug],
    // The app starts once its release companion (migrations) exited 0: one `compose up --wait` runs both, and a failed migration fails it.
    ...(cfg.release ? { depends_on: { [releaseServiceName(slug)]: { condition: 'service_completed_successfully' as const } } } : {}),
    restart: 'unless-stopped',
    ...privileges(cfg),
    // The pools forward to the host ports directly, with no ingress hop on the machine; their check asks the machine's agent, which probes the app's own health path.
    ports: [cfg.port, ...(cfg.internalPort === undefined ? [] : [cfg.internalPort])].map((port) => `${port}:${port}`),
    // SIGTERM drain window for in-flight requests.
    stop_grace_period: '30s',
    ...(cfg.includeEnvFile === false ? {} : { env_file: envFiles }),
    environment,
    healthcheck: healthcheck(cfg.port, cfg.startPeriod),
  };
  block['x-service'] = metaFrom(slug, cfg);
  return block;
}

/** The one-shot release companion's compose service name (and its own profile). */
function releaseServiceName(slug: string): string {
  return `${slug}-release`;
}

/**
 * One-shot release companion for a service that declares a `release` step: the service image with the step's env, run
 * at the new machine's boot BEFORE the app starts, which depends on its exit 0.
 * It shares the service's profile, so the agent's `--profile <service>` starts it with the app.
 */
function releaseBlock(slug: string, cfg: AppServiceConfig): ComposeService {
  const release = cfg.release;
  return {
    image: cfg.image,
    pull_policy: 'never',
    profiles: [slug],
    restart: 'no',
    ...privileges(cfg),
    env_file: envFiles,
    environment: { ...standardEnv, ...(release?.env ?? {}), ...(cfg.env ?? {}) },
  };
}

/** The agent's compose service, which every machine runs beside its app (agent/): the launcher starts it, and it starts the rest. */
export const agentService = 'infra-agent';

/** The agent's compose profile and bake target, which an app service takes from its slug. */
export const agentProfile = 'agent';

/**
 * The agent: on the host network, where it answers the load balancer on each service's agent port and reads its manifest from the metadata
 * service, which answers only a source port below 1024, so it keeps that one capability and drops the rest. It drives the host's Docker
 * daemon through its socket, reads its plan from `AGENT_DIR` (`/etc/<slug>`, set in the machine's static env) and the boot log read-only.
 * The machine's unit supervises it, so Docker restarts it never.
 */
function agentBlock(): ComposeService {
  return {
    image: '${REGISTRY}/infra-agent:${AGENT_TAG}',
    pull_policy: 'never',
    profiles: [agentProfile],
    restart: 'no',
    command: ['agent', '--plan', '${AGENT_DIR}/boot-plan.json'],
    network_mode: 'host',
    cap_drop: ['ALL'],
    cap_add: ['NET_BIND_SERVICE'],
    volumes: [
      '/var/run/docker.sock:/var/run/docker.sock',
      '/opt/app:/opt/app',
      '${AGENT_DIR}:${AGENT_DIR}',
      '/var/log/infra-boot.log:/var/log/infra-boot.log:ro',
    ],
  };
}

/**
 * Assemble the full `ComposeFile` from the app's service registry. Each service is one app block binding the host
 * port directly; zero-downtime overlap happens at the load balancer between two machines, not inside one.
 * A `release` step additionally emits a one-shot companion run at the new machine's boot before the app starts.
 * `processIdentityEnv` names the env keys selecting a container's process identity (which service);
 * they are never folded from a co-hosted worker into the singleVM host.
 */
export function assembleCompose(appServices: AppServices, options: { processIdentityEnv?: readonly string[] } = {}): ComposeFile {
  const processIdentityEnv = new Set(options.processIdentityEnv ?? []);
  const services: Record<string, ComposeService> = {};
  for (const [slug, cfg] of Object.entries(appServices)) {
    services[slug] = appBlock(slug, cfg);
    if (cfg.release) services[releaseServiceName(slug)] = releaseBlock(slug, cfg);
  }
  services[agentService] = agentBlock();
  publishCoHostedPorts(appServices, services);
  publishCoHostedEnv(appServices, services, processIdentityEnv);
  return { services };
}

/** The singleVM host: the `primaryRollout` service and its block; undefined when no service has both. */
function singleVmHost(appServices: AppServices, blocks: Record<string, ComposeService>): { hostSlug: string; hostBlock: ComposeService } | undefined {
  const hostSlug = Object.entries(appServices).find(([, cfg]) => cfg.primaryRollout)?.[0];
  const hostBlock = hostSlug === undefined ? undefined : blocks[hostSlug];
  return hostSlug && hostBlock ? { hostSlug, hostBlock } : undefined;
}

/**
 * Fold co-hosted service environments into the singleVM host block, which supplies their placeholders because worker blocks do not start.
 * Equal collisions are accepted, conflicting values fail synthesis, and process-identity keys are skipped (folded workers boot under the host's identity).
 */
function publishCoHostedEnv(appServices: AppServices, blocks: Record<string, ComposeService>, processIdentityEnv: ReadonlySet<string>): void {
  const host = singleVmHost(appServices, blocks);
  if (!host) return;
  const { hostSlug, hostBlock } = host;
  const merged: Record<string, string> = { ...(hostBlock.environment ?? {}) };
  for (const [slug, cfg] of Object.entries(appServices)) {
    if (!cfg.coHosted || !cfg.env) continue;
    for (const [key, value] of Object.entries(cfg.env)) {
      if (processIdentityEnv.has(key)) continue;
      const existing = merged[key];
      if (existing !== undefined && existing !== value) {
        throw new Error(
          `compose synth: co-hosted service '${slug}' env '${key}=${value}' conflicts with '${existing}' already on host '${hostSlug}': rename the worker's variable in cella/infra/description.yml (folded env must not overload host keys).`,
        );
      }
      merged[key] = value;
    }
  }
  hostBlock.environment = merged;
}

/**
 * Publish co-hosted worker ports on the singleVM host for load-balancer access.
 * Split mode keeps them in the shared Compose output, where nothing binds them and network policy keeps them unreachable.
 */
function publishCoHostedPorts(appServices: AppServices, blocks: Record<string, ComposeService>): void {
  const hostBlock = singleVmHost(appServices, blocks)?.hostBlock;
  if (!hostBlock) return;
  const coHostedPorts = Object.values(appServices)
    .filter((cfg) => cfg.coHosted)
    .flatMap((cfg) => [cfg.port, ...(cfg.internalPort === undefined ? [] : [cfg.internalPort])])
    .map((port) => `${port}:${port}`);
  if (coHostedPorts.length === 0) return;
  const existing = new Set(hostBlock.ports ?? []);
  hostBlock.ports = [...(hostBlock.ports ?? []), ...coHostedPorts.filter((p) => !existing.has(p))];
}
