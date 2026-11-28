import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { type ImportExport, resolveApp, resolveFile } from './resolve';
import type { descriptionSchema, engineConfigSchema } from './schema';

type File = z.input<typeof descriptionSchema>;
type AppConfig = z.input<typeof engineConfigSchema>;

const service = { startPeriod: '10s', replacementStrategy: 'start-first', instanceType: 'DEV1-S' } as const;

const baseFile = (): File => ({
  general: {
    compute: { image: 'docker' },
    database: { nodeType: 'DB-DEV-S', volumeSizeGb: 10 },
    assets: { retentionDays: 14 },
    schedule: { everyMinutes: 5 },
  },
  processIdentityEnv: ['SERVICE'],
  services: {
    api: { ...service, port: 4000, dockerfile: 'Dockerfile', lbRoute: 'path', pathPrefix: '/api', env: { APP_ORIGIN: '@{web.url}' } },
    'bg-jobs': { ...service, port: 4006, reusesImageOf: 'api' },
    web: { ...service, dockerfile: 'engine:proxy', port: 80, lbRoute: 'default', headers: 'shared/csp.ts#headers' },
  },
  runtimeSecrets: {
    SIGNING_KEY: { secretName: 'signing-key', description: 'Signs tokens', services: ['api'], generation: 'random', rotatable: true },
    PUBLIC_KEY: { description: 'Verifies tokens', services: ['bg-jobs'], derivedFrom: { secret: 'SIGNING_KEY', with: 'shared/key.ts#publicKey' } },
    MAIL_API_KEY: { description: 'Sends mail', services: ['api'], group: 'Mail' },
  },
  stores: { primary: { kind: 'postgres-managed', secretConsumers: { runtime: ['api'], admin: ['api'], cdc: [], ca: ['api'] } } },
  managedKeys: {
    ai: {
      suffix: 'ai',
      label: 'AI',
      appDescription: 'AI principal',
      policyDescription: 'AI policy',
      permissionSets: [],
      prompt: { message: 'Mint?', default: false },
      assign: { secretKey: 'MAIL_API_KEY' },
    },
  },
});

const baseAppConfig = (): AppConfig => ({
  slug: 'app',
  appSlug: 'app',
  mode: 'production',
  domain: 'example.com',
  frontendUrl: 'https://www.example.com',
  backendUrl: 'https://www.example.com/api',
  singleVM: false,
  s3: { region: 'nl-ams', host: 's3.example.com', publicBucketName: 'p', privateBucketName: 'q', publicCDNUrl: '', privateCDNUrl: '' },
  services: { api: { port: 4000, publicUrl: 'https://www.example.com/api' }, web: { port: 3000 } },
  retention: { backupDays: 7 },
});

const headers = { csp: "default-src 'self'", embedCsp: "frame-ancestors 'none'", permissionsPolicy: 'camera=()' };
const appExports: Record<string, Record<string, unknown>> = {
  'shared/csp.ts': {
    headers,
    placeholder: { ...headers, csp: "default-src 'self' {env.SIGNING_KEY}" },
    commented: { ...headers, permissionsPolicy: 'camera=() #microphone=()' },
    plain: 'x',
  },
  'shared/key.ts': {
    publicKey: (value: string) => `public:${value}`,
    throws: () => {
      throw new Error('no key');
    },
  },
  // Files a reference must not reach: the rows that name them fail on the reference's form, not on a missing export
  'backend/key.ts': { publicKey: (value: string) => value },
  '../key.ts': { publicKey: (value: string) => value },
};
const importExport: ImportExport = async (path, exportName) => appExports[path]?.[exportName];

/** Both stages, the file's then the app's, for the production `APP_MODE` unless one is given. */
const resolveWith = async (edit: (file: File, appConfig: AppConfig) => void = () => {}, mode = 'production') => {
  const file = baseFile();
  const appConfig = baseAppConfig();
  edit(file, appConfig);
  const files = resolveFile(file, importExport);
  return { ...files, ...(await resolveApp(files, appConfig, mode, importExport)) };
};

describe('the description refuses', () => {
  const cases: [refusal: string, keyPath: string, edit: (file: File, appConfig: AppConfig) => void][] = [
    ['an unknown key', 'services.api.colour', (f) => Object.assign(f.services.api, { colour: 'red' })],
    ['a service without a port', 'services.bg-jobs.port', (f) => Object.assign(f.services['bg-jobs'], { port: undefined })],
    ['a port appConfig gives another', 'services.api.port', (_f, c) => Object.assign(c.services.api, { port: 4100 })],
    ['an internal port appConfig gives another', 'services.api.internalPort', (_f, c) => Object.assign(c.services.api, { internalPort: 4105 })],
    [
      'a path appConfig gives another',
      'services.api.pathPrefix',
      (_f, c) => Object.assign(c.services.api, { publicUrl: 'https://www.example.com/v2' }),
    ],
    ['a path route without a public URL', 'services.api.pathPrefix', (_f, c) => delete c.services.api.publicUrl],
    [
      'rotatable without generation: random',
      'runtimeSecrets.MAIL_API_KEY.rotatable',
      (f) => Object.assign(f.runtimeSecrets.MAIL_API_KEY, { rotatable: true }),
    ],
    [
      'derivedFrom naming an unknown variable',
      'runtimeSecrets.PUBLIC_KEY.derivedFrom.secret',
      (f) => Object.assign(f.runtimeSecrets.PUBLIC_KEY, { derivedFrom: { secret: 'MISSING_KEY', with: 'shared/key.ts#publicKey' } }),
    ],
    [
      'a reference that leaves the app root',
      'runtimeSecrets.PUBLIC_KEY.derivedFrom.with',
      (f) => Object.assign(f.runtimeSecrets.PUBLIC_KEY, { derivedFrom: { secret: 'SIGNING_KEY', with: 'shared/../../key.ts#publicKey' } }),
    ],
    [
      'an export that is no function',
      'runtimeSecrets.PUBLIC_KEY.derivedFrom.with',
      (f) => Object.assign(f.runtimeSecrets.PUBLIC_KEY, { derivedFrom: { secret: 'SIGNING_KEY', with: 'shared/csp.ts#plain' } }),
    ],
    [
      'headers on a service that is not the proxy',
      'services.api.headers',
      (f) => Object.assign(f.services.api, { headers: 'shared/csp.ts#headers' }),
    ],
    ['the proxy without headers', 'services.web.headers', (f) => delete f.services.web.headers],
    ['an unknown store kind', 'stores.primary.kind', (f) => Object.assign(f.stores.primary, { kind: 'redis' })],
    [
      'assign naming an unknown variable',
      'managedKeys.ai.assign.secretKey',
      (f) => Object.assign(f.managedKeys.ai.assign, { secretKey: 'MISSING_KEY' }),
    ],
    [
      'two secrets with one stored name',
      'runtimeSecrets.MAIL_API_KEY.secretName',
      (f) => Object.assign(f.runtimeSecrets.MAIL_API_KEY, { secretName: 'signing-key' }),
    ],
    [
      "the repository read key's stored name",
      'runtimeSecrets.MAIL_API_KEY.secretName',
      (f) => Object.assign(f.runtimeSecrets.MAIL_API_KEY, { secretName: 'repository-read-key' }),
    ],
    [
      "the uploads key's stored name",
      'runtimeSecrets.MAIL_API_KEY.secretName',
      (f) => Object.assign(f.runtimeSecrets.MAIL_API_KEY, { secretName: 'uploads-access-key' }),
    ],
    ['a generated secret without its stored name', 'runtimeSecrets.SIGNING_KEY.secretName', (f) => delete f.runtimeSecrets.SIGNING_KEY.secretName],
    // A key holding a line break would add a key of its own to the rendered Compose file
    [
      'an env key that is no variable name',
      'services.api.env."X\\nprivileged: true"',
      (f) => Object.assign(f.services.api, { env: { 'X\nprivileged: true': 'x' } }),
    ],
    [
      'a release env key that is no variable name',
      'services.api.release.env.debug',
      (f) => Object.assign(f.services.api, { release: { env: { debug: '1' } } }),
    ],
    ['a process identity entry that is no variable name', 'processIdentityEnv.1', (f) => f.processIdentityEnv.push('service')],
    [
      'a runtime secret keyed by no variable name',
      'runtimeSecrets.mail-key',
      (f) => Object.assign(f.runtimeSecrets, { 'mail-key': { description: 'Mail', services: ['api'] } }),
    ],
    [
      "an env key that is a runtime secret's variable",
      'services.api.env.MAIL_API_KEY',
      (f) => Object.assign(f.services.api, { env: { MAIL_API_KEY: 'k' } }),
    ],
    [
      "a release env key that is a store's secret variable",
      'services.api.release.env.DATABASE_URL',
      (f) => Object.assign(f.services.api, { release: { env: { DATABASE_URL: 'postgres://elsewhere' } } }),
    ],
    [
      "a dockerfile naming the engine's proxy by its path",
      'services.api.dockerfile',
      (f) => Object.assign(f.services.api, { dockerfile: '/engine-assets/caddy/Dockerfile' }),
    ],
    [
      'a header value holding a Caddy placeholder',
      'services.web.headers: csp',
      (f) => Object.assign(f.services.web, { headers: 'shared/csp.ts#placeholder' }),
    ],
    [
      'a derivation that throws on the probe input',
      'runtimeSecrets.PUBLIC_KEY.derivedFrom.with',
      (f) => Object.assign(f.runtimeSecrets.PUBLIC_KEY, { derivedFrom: { secret: 'SIGNING_KEY', with: 'shared/key.ts#throws' } }),
    ],
    // The engine image copies shared/ and cella/infra/ alone: infra/ is a folder of the old layout
    [
      'a reference outside shared/ and cella/infra/',
      'runtimeSecrets.PUBLIC_KEY.derivedFrom.with',
      (f) => Object.assign(f.runtimeSecrets.PUBLIC_KEY, { derivedFrom: { secret: 'SIGNING_KEY', with: 'infra/key.ts#publicKey' } }),
    ],
    // The form passes the schema's pattern: the normalized path leaves shared/
    [
      'a reference that leaves shared/ through ..',
      'runtimeSecrets.PUBLIC_KEY.derivedFrom.with',
      (f) => Object.assign(f.runtimeSecrets.PUBLIC_KEY, { derivedFrom: { secret: 'SIGNING_KEY', with: 'shared/../backend/key.ts#publicKey' } }),
    ],
    // zod drops a record entry keyed __proto__, which the file still shows, and keeps one keyed constructor, which a lookup reads wrong
    ['a key named __proto__', 'services.__proto__', (f) => Object.defineProperty(f.services, '__proto__', { value: service, enumerable: true })],
    ['a key named constructor', 'services.constructor', (f) => Object.assign(f.services, { constructor: { ...service, port: 4010 } })],
    [
      "a slug ending in a release companion's suffix",
      'services.api-release',
      (f) => Object.assign(f.services, { 'api-release': { ...service, port: 4010 } }),
    ],
    ["the slug of the engine's agent", 'services.agent', (f) => Object.assign(f.services, { agent: { ...service, port: 4010 } })],
    // A build deletes every machine whose name starts with <prefix>-builder-
    ['a slug of the builder machines', 'services.builder-cache', (f) => Object.assign(f.services, { 'builder-cache': { ...service, port: 4010 } })],
    ["the slug of the builder's security group", 'services.compute', (f) => Object.assign(f.services, { compute: { ...service, port: 4010 } })],
    ['the slug of a bake group', 'services.services', (f) => Object.assign(f.services, { services: { ...service, port: 4010 } })],
    [
      "a slug ending in an internal pool's suffix",
      'services.api-internal',
      (f) => Object.assign(f.services, { 'api-internal': { ...service, port: 4010 } }),
    ],
    // The load balancer names the backend's resources api-*, and the default route's DNS record and certificate after its base name
    ["the slug the backend's resources are created under", 'services.api', (f) => Object.assign(f.services, { backend: { ...service, port: 4010 } })],
    ['apex on the default route', 'services.apex', (f) => Object.assign(f.services, { apex: { ...service, port: 4010, lbRoute: 'default' } })],
    ["a managed key's suffix of an engine principal", 'managedKeys.ai.suffix', (f) => Object.assign(f.managedKeys.ai, { suffix: 'ci-deploy' })],
    // On the single-process host the static env file serves every container: a binding there would move the proxy's origin
    ["an env key the engine's proxy takes", 'services.api.env.ORIGIN_HOST', (f) => Object.assign(f.services.api, { env: { ORIGIN_HOST: 'x' } })],
    ["an env key of the agent's", 'services.api.env.AGENT_DIR', (f) => Object.assign(f.services.api, { env: { AGENT_DIR: '/tmp' } })],
    [
      "a release env key of a service's release tag",
      'services.api.release.env.WEB_TAG',
      (f) => Object.assign(f.services.api, { release: { env: { WEB_TAG: 'old' } } }),
    ],
    // Compose would interpolate it from the static env file
    [
      'a Compose placeholder in an env value',
      'services.api.env.APP_ORIGIN',
      (f) => Object.assign(f.services.api, { env: { APP_ORIGIN: '${APP_ORIGIN}' } }),
    ],
    // The static env file cuts an unquoted value at a # after whitespace
    ['a # after whitespace in an env value', 'services.api.env.NOTE', (f) => Object.assign(f.services.api, { env: { NOTE: 'a #b' } })],
    [
      'a # after whitespace in a header value',
      'services.web.headers: permissionsPolicy',
      (f) => Object.assign(f.services.web, { headers: 'shared/csp.ts#commented' }),
    ],
    // The builder would bake from outside the checkout
    [
      'a dockerfile path with a .. segment',
      'services.api.dockerfile',
      (f) => Object.assign(f.services.api, { dockerfile: 'docker/../../Dockerfile' }),
    ],
    [
      'a default stored name that is no kebab-case name',
      'runtimeSecrets.MAIL__KEY.secretName',
      (f) => Object.assign(f.runtimeSecrets, { MAIL__KEY: { description: 'Mail', services: ['api'] } }),
    ],
    // Its path would fall to the proxy
    [
      'a service appConfig serves under a path, without lbRoute: path',
      'services.bg-jobs.lbRoute',
      (_f, c) => Object.assign(c.services, { 'bg-jobs': { port: 4006, publicUrl: 'https://www.example.com/jobs' } }),
    ],
  ];

  it.each(cases)('%s at %s', async (_refusal, keyPath, edit) => {
    await expect(resolveWith(edit)).rejects.toThrow(`: ${keyPath}: `);
  });

  it('a variable whose id every JavaScript object has', async () => {
    const edit = (f: File) => Object.assign(f.runtimeSecrets, { TO_STRING: { description: 'Text', services: ['api'] } });
    await expect(resolveWith(edit)).rejects.toThrow("runtimeSecrets.TO_STRING: gives the id 'toString', a member every JavaScript object has");
  });

  it("an appConfig of another mode than APP_MODE's", async () => {
    await expect(resolveWith(undefined, 'staging')).rejects.toThrow("appConfig: mode 'production' loaded where APP_MODE is 'staging'");
  });
});

describe('the description defaults', async () => {
  const { appServices, runtimeSecretsConfig, proxyHeaders } = await resolveWith();
  const { derivedFrom, ...derived } = runtimeSecretsConfig.publicKey;

  const cases: [fact: string, actual: unknown, expected: unknown][] = [
    ['the image of a service that builds its own', appServices.api.image, '${REGISTRY}/api:${API_TAG:-latest}'],
    ['the image of a service that reuses another', appServices['bg-jobs'].image, '${REGISTRY}/api:${BG_JOBS_TAG:-latest}'],
    ['the stored name', runtimeSecretsConfig.mailApiKey.secretName, 'mail-api-key'],
    ['the id', Object.keys(runtimeSecretsConfig), ['signingKey', 'publicKey', 'mailApiKey']],
    [
      'a generated secret',
      runtimeSecretsConfig.signingKey,
      expect.objectContaining({ valueSource: 'engine', generation: 'random', required: true, rotatable: true }),
    ],
    ['a derived secret', derived, expect.objectContaining({ valueSource: 'engine', generation: 'manual', required: true })],
    ['its derivation', { secretId: derivedFrom?.secretId, value: await derivedFrom?.derive('k') }, { secretId: 'signingKey', value: 'public:k' }],
    ['the proxy header values', proxyHeaders, appExports['shared/csp.ts']?.headers],
    [
      'an operator secret',
      runtimeSecretsConfig.mailApiKey,
      expect.objectContaining({ valueSource: 'operator', generation: 'manual', required: false }),
    ],
  ];

  it.each(cases)('%s', (_fact, actual, expected) => {
    expect(actual).toEqual(expected);
  });
});
