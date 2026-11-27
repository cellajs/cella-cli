import { z } from 'zod';
import { environments } from '../stack/environment';

/** A value fixed for every mode, or one per mode. */
const perMode = <T extends z.ZodType>(value: T) => z.union([value, z.partialRecord(z.enum(environments), value)]);

/** Lowercase kebab-case: a service slug, a stored secret name, the app's slug. */
const kebab = z.string().regex(/^[a-z][a-z0-9-]*$/, 'takes lowercase kebab-case');

/** An environment variable's name, as a regular expression's source: an `env` key, a runtime secret's key, a `${NAME}` of the Compose file. */
export const variableName = '[A-Z_][A-Z0-9_]*';

const variable = z.string().regex(new RegExp(`^${variableName}$`), 'takes an upper-case variable name');

/** `'<path from the app root>#<export>'`, the path under `shared/` or `infra/`: the engine image holds those two folders alone. */
export const referenceSchema = z
  .string()
  .regex(/^(?:shared|infra)\/[^#]+#[A-Za-z_$][\w$]*$/, "takes a reference '<path>#<export>' to a file under shared/ or infra/");

/** A service's environment: each key becomes a variable of its container. */
const envMap = z.record(variable, z.string());

const serviceSchema = z.strictObject({
  s3Access: z.boolean().optional(),
  port: z.int().min(1),
  startPeriod: z.string(),
  replacementStrategy: z.enum(['start-first', 'stop-first']),
  release: z.strictObject({ env: envMap.optional() }).optional(),
  primaryRollout: z.boolean().optional(),
  drainPolicy: z.enum(['requests', 'reconnect']).optional(),
  drainSeconds: z.number().min(0).optional(),
  lbRoute: z.enum(['default', 'path']).optional(),
  lbWebsockets: z.boolean().optional(),
  internalPort: z.int().optional(),
  pathPrefix: z.templateLiteral(['/', z.string()]).optional(),
  reusesImageOf: kebab.optional(),
  /** A path, or `engine:proxy` for the engine's frontend proxy. */
  dockerfile: z.string().optional(),
  target: z.string().optional(),
  coHosted: z.boolean().optional(),
  placement: z.enum(['vm', 'host']).optional(),
  instanceType: perMode(z.string()),
  capabilities: z.array(z.string()).optional(),
  /** A value holding `@{` is a binding template; any other value is literal. */
  env: envMap.optional(),
  includeStandardEnv: z.boolean().optional(),
  includeEnvFile: z.boolean().optional(),
  /** The proxy's header values: required on the `engine:proxy` service, refused on any other. */
  headers: referenceSchema.optional(),
});

const runtimeSecretSchema = z.strictObject({
  description: z.string().min(1),
  services: z.array(kebab).min(1),
  /**
   * Defaults to the variable in kebab-case, except on a generated secret, which states it. Pulumi names the secret's resources by it, so
   * it never changes.
   */
  secretName: kebab.optional(),
  required: z.boolean().optional(),
  generation: z.literal('random').optional(),
  rotatable: z.boolean().optional(),
  group: z.string().optional(),
  derivedFrom: z.strictObject({ secret: variable, with: referenceSchema }).optional(),
});

const storeSchema = z.strictObject({
  kind: z.enum(['postgres-managed']),
  secretConsumers: z.strictObject({ runtime: z.array(kebab), admin: z.array(kebab), cdc: z.array(kebab), ca: z.array(kebab) }),
});

const managedKeySchema = z.strictObject({
  suffix: z.string(),
  label: z.string(),
  appDescription: z.string(),
  policyDescription: z.string(),
  permissionSets: z.array(z.string()),
  prompt: z.strictObject({ message: z.string(), default: z.boolean() }),
  /** Each minted key half's runtime secret, named by its variable. */
  assign: z.strictObject({ accessKey: variable.optional(), secretKey: variable.optional() }),
});

const generalSchema = z.strictObject({
  compute: z.strictObject({ image: z.string() }),
  database: z.strictObject({ nodeType: perMode(z.string()), volumeSizeGb: perMode(z.number()) }),
  assets: z.strictObject({ retentionDays: perMode(z.number()) }),
  schedule: z.strictObject({ everyMinutes: perMode(z.number()) }),
});

/** `infra/description.yml`: the app's services, secrets, stores, keys and general settings. */
export const descriptionSchema = z.strictObject({
  general: generalSchema,
  processIdentityEnv: z.array(variable),
  services: z.record(kebab, serviceSchema),
  runtimeSecrets: z.record(variable, runtimeSecretSchema),
  stores: z.record(z.string(), storeSchema),
  managedKeys: z.record(z.string(), managedKeySchema),
});

export type DescriptionFile = z.infer<typeof descriptionSchema>;

/** A header value the Caddyfile writes inside double quotes: a quote, a backslash, a placeholder brace, `$` or a backtick would change it. */
const headerValue = z.string().regex(/^[^"\\{}$`\p{Cc}]*$/u, 'takes no double quote, backslash, brace, $, backtick or control character');

/** The proxy's response headers, which the engine supplies to its env. */
export const proxyHeadersSchema = z.strictObject({ csp: headerValue, embedCsp: headerValue, permissionsPolicy: headerValue });

export type ProxyHeaders = z.infer<typeof proxyHeadersSchema>;

/** The engine's part of the app's `appConfig`: every other field is dropped. */
export const engineConfigSchema = z.object({
  /**
   * The prefix of every Scaleway resource and bucket, a machine's `/etc/<slug>` and the `::<slug>::` serial marker of its first-boot
   * script: kebab-case keeps each shell use of it safe without quoting.
   */
  slug: kebab,
  /** The app's own slug, the same in every environment: it names what the app has one of, the operator and the observer. */
  appSlug: kebab,
  /** Deploys accept 'production' or 'staging'. */
  mode: z.string(),
  /** The registered DNS zone the app deploys under: 'localhost' disables deploys. */
  domain: z.string(),
  frontendUrl: z.string(),
  backendUrl: z.string(),
  /** The backend co-hosts every enabled worker in its process. */
  singleVM: z.boolean(),
  s3: z.object({
    region: z.string(),
    host: z.string(),
    publicBucketName: z.string(),
    privateBucketName: z.string(),
    publicCDNUrl: z.string(),
    privateCDNUrl: z.string(),
  }),
  services: z.record(
    z.string(),
    z.object({ enabled: z.boolean().optional(), publicUrl: z.string().optional(), port: z.int().optional(), internalPort: z.int().optional() }),
  ),
  retention: z.object({ backupDays: z.number() }),
});

export type DescribedEngineConfig = z.infer<typeof engineConfigSchema>;
