import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { fakeConfig } from '../../tests/helpers/fake-config';
import { resolveFile } from '../description/resolve';
import { machineRoles } from '../machine-roles';
import { deriveInfra } from '../naming';
import { staticEnv } from './static-env';

const envOf = (text: string) =>
  Object.fromEntries(text.split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

/** The engine's modules a render reads the description through: a test that edits the description loads them again. */
const engine = { staticEnv, machineRoles, deriveInfra };

function render(singleVM: boolean, role: string, csp = 'csp', { staticEnv, machineRoles, deriveInfra } = engine) {
  const { services } = fakeConfig();
  const config = fakeConfig({ singleVM, services: { ...services, yjs: { ...services.yjs, enabled: true } } });
  const machine = machineRoles(config).find((candidate) => candidate.role === role);
  if (!machine) throw new Error(`no role ${role}`);
  const { naming, region } = deriveInfra(config);
  return envOf(
    staticEnv({
      role: machine,
      registry: 'rg.fr-par.scw.cloud/cella',
      release: 'abc',
      agentDir: '/etc/cella',
      lbInternalAddress: '10.0.0.200',
      suppliers: {
        FRONTEND_CSP: () => csp,
        FRONTEND_EMBED_CSP: () => 'csp',
        FRONTEND_PERMISSIONS_POLICY: () => 'policy',
        ORIGIN_HOST: () => 'bucket',
      },
      context: { config, naming, region, mode: 'production', serviceUrl: (slug) => `https://${slug}.example` },
    }),
  );
}

describe("a machine's static env", () => {
  it("dials the backend's internal listener at the load balancer's private address, which follows every switch, never a machine's", () => {
    expect(render(false, 'cdc').BACKEND_INTERNAL_URL).toBe('http://10.0.0.200:14005');
    expect(render(false, 'yjs').BACKEND_INTERNAL_URL).toBe('http://10.0.0.200:14005');
  });

  it('collapses a folded worker on the single-process host to its own process', () => {
    expect(render(true, 'backend').BACKEND_INTERNAL_URL).toBe('http://127.0.0.1:4005');
  });

  it('names the release tag of every image it runs and the agent it starts', () => {
    expect(render(false, 'backend')).toMatchObject({
      REGISTRY: 'rg.fr-par.scw.cloud/cella',
      BACKEND_TAG: 'abc',
      AGENT_TAG: 'abc',
      AGENT_DIR: '/etc/cella',
    });
  });

  it('must not let a value end its line: a CRLF in the CSP would add a header the Caddy proxy sends', () => {
    expect(() => render(true, 'backend', "default-src 'self'\r\nSet-Cookie: a=b")).toThrow(/FRONTEND_CSP holds a control character/);
  });

  it('gives a service the origin its APP_ORIGIN binding names', () => {
    expect(render(false, 'backend').APP_ORIGIN).toBe('https://frontend.example');
  });

  it("sets the tag variable a hyphenated slug's image reads, and resolves a binding that names the slug", async () => {
    vi.resetModules();
    vi.doMock('../description', async (importOriginal) => {
      const original = await importOriginal<typeof import('../description')>();
      const file = parse(readFileSync('cella/infra/description.yml', 'utf8'));
      file.services['bg-jobs'] = {
        port: 4007,
        startPeriod: '15s',
        replacementStrategy: 'stop-first',
        reusesImageOf: 'backend',
        instanceType: 'DEV1-S',
        env: { SERVICE: 'bg-jobs', OWN_PORT: '@{bg-jobs.port}' },
      };
      return { ...original, ...resolveFile(file, original.importAppExport) };
    });
    const [{ composeConfig }, { staticEnv }, { machineRoles }, { deriveInfra }] = await Promise.all([
      import('../../compose/compose'),
      import('./static-env'),
      import('../machine-roles'),
      import('../naming'),
    ]);
    vi.doUnmock('../description');
    const env = render(false, 'bg-jobs', 'csp', { staticEnv, machineRoles, deriveInfra });
    const tagVariable = composeConfig.services['bg-jobs']?.image.match(/\$\{(\w+):-latest\}$/)?.[1] ?? '';
    expect({ tagVariable, tag: env[tagVariable], OWN_PORT: env.OWN_PORT }).toEqual({ tagVariable: 'BG_JOBS_TAG', tag: 'abc', OWN_PORT: '4007' });
  });
});
