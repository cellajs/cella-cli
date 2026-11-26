import { describe, expect, it } from 'vitest';
import { frontendProxyDockerfile } from '../lib/builder/builder-machine';
import { rootNodeVersion } from '../lib/deploy/main-job';
import { bakeDefinition } from './build-images';

const nodeVersion = rootNodeVersion();
const base = { registry: 'rg.nl-ams.scw.cloud', namespace: 'app', releaseSha: 'abc', nodeVersion, archiveDir: '/run/images' };

describe('bakeDefinition', () => {
  it('builds each image from its own stage: a stage lost on the way builds every image of the file as its last stage', () => {
    const rows = [
      { service: 'backend', dockerfile: 'Dockerfile', target: 'backend' },
      { service: 'yjs', dockerfile: 'Dockerfile', target: 'yjs' },
      { service: 'frontend', dockerfile: frontendProxyDockerfile, target: '' },
    ];
    const { target } = bakeDefinition(rows, { ...base, context: '/build' });
    expect((target.backend as { target?: string }).target).toBe('backend');
    expect((target.yjs as { target?: string }).target).toBe('yjs');
    expect(target.frontend).not.toHaveProperty('target');
    // The engine's images build in the folders the builder stages, beside what their Dockerfile copies
    expect(target.frontend).toMatchObject({ context: '/engine-assets/caddy', dockerfile: 'Dockerfile' });
    expect((target.agent as { context: string }).context).toBe('/engine-assets/agent');
  });

  it('builds every image, the agent included, on a node base pinned by digest at the root engines.node: a moved tag reaches none', () => {
    const rows = [{ service: 'backend', dockerfile: 'Dockerfile', target: 'backend' }];
    const { target } = bakeDefinition(rows, base);
    expect(target.backend).toMatchObject({ args: { RELEASE_SHA: 'abc', NODE_IMAGE: expect.stringMatching(/-alpine@sha256:[0-9a-f]{64}$/) } });
    expect(target.agent).toMatchObject({ args: { NODE_IMAGE: expect.stringMatching(/-bookworm-slim@sha256:[0-9a-f]{64}$/) } });
  });

  it('writes every image as an archive under the tag the compose file names, and pushes none to the registry', () => {
    const rows = [{ service: 'backend', dockerfile: 'Dockerfile', target: 'backend' }];
    const bake = bakeDefinition(rows, base);
    expect(bake.group).toMatchObject({ services: { targets: ['backend'] }, engine: { targets: ['agent'] } });
    expect(bake.target.backend).toMatchObject({
      tags: ['rg.nl-ams.scw.cloud/app/backend:abc'],
      output: ['type=docker,dest=/run/images/backend.tar'],
    });
    expect(bake.target.agent).toMatchObject({ output: ['type=docker,dest=/run/images/infra-agent.tar'] });
    expect(JSON.stringify(bake)).not.toMatch(/cache-|push|type=registry/);
  });
});
