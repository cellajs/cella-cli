import { describe, expect, it } from 'vitest';
import { buildDeployEnv } from './deploy-env';

const fakeAppConfig = {
  slug: 'cella',
  mode: 'production',
  s3: { region: 'nl-ams', publicBucketName: 'cella-public', privateBucketName: 'cella-private', host: 's3.nl-ams.scw.cloud' },
  domain: 'cella.example',
  frontendUrl: 'https://www.cella.example',
  backendUrl: 'https://www.cella.example/api',
  yjsUrl: 'wss://www.cella.example/yjs',
  mcpUrl: 'https://www.cella.example/mcp',
  oauthUrl: 'https://www.cella.example/oauth',
  services: {
    frontend: { enabled: true, publicUrl: 'https://www.cella.example' },
    backend: { enabled: true, publicUrl: 'https://www.cella.example/api' },
    cdc: { enabled: true },
    yjs: { enabled: false, publicUrl: 'wss://www.cella.example/yjs' },
    mcp: { enabled: false, publicUrl: 'https://www.cella.example/mcp' },
    oauth: { enabled: false, publicUrl: 'https://www.cella.example/oauth' },
  },
  securityEmail: 'security@cella.example',
} as any;

describe('buildDeployEnv', () => {
  it('derives values from appConfig', () => {
    expect(buildDeployEnv(fakeAppConfig)).toEqual({
      stack: 'production',
      region: 'nl-ams',
      frontend_bucket: 'cella-frontend',
      public_bucket: 'cella-public',
      diag_bucket: 'cella-boot-diag',
      enabled_services: [
        {
          service: 'backend',
          public_url: 'https://www.cella.example/api',
          health_url: 'https://www.cella.example/api',
          lb_route: 'path',
          dockerfile: 'Dockerfile',
          reuses_image_of: '',
          primary_rollout: true,
        },
        { service: 'cdc', public_url: '', health_url: '', lb_route: '', dockerfile: 'Dockerfile', reuses_image_of: '', primary_rollout: false },
        { service: 'jobs', public_url: '', health_url: '', lb_route: '', dockerfile: '', reuses_image_of: 'backend', primary_rollout: false },
        {
          service: 'frontend',
          public_url: 'https://www.cella.example',
          health_url: 'https://www.cella.example',
          lb_route: 'default',
          dockerfile: '/engine-assets/caddy/Dockerfile',
          reuses_image_of: '',
          primary_rollout: false,
        },
      ],
      build_images: [
        { service: 'backend', dockerfile: 'Dockerfile', target: 'backend' },
        { service: 'cdc', dockerfile: 'Dockerfile', target: 'cdc' },
        { service: 'frontend', dockerfile: '/engine-assets/caddy/Dockerfile', target: '' },
      ],
      primary_role: 'backend',
      apex_url: 'https://cella.example',
    });
  });

  it('derives public URLs in enabled_services from appConfig.services', () => {
    const cfg = {
      ...fakeAppConfig,
      frontendUrl: 'https://legacy-front.example',
      backendUrl: 'https://legacy-api.example',
      services: {
        ...fakeAppConfig.services,
        frontend: { enabled: true, publicUrl: 'https://app.cella.example' },
        backend: { enabled: true, publicUrl: 'https://app.cella.example/api' },
      },
    };
    const services = buildDeployEnv(cfg).enabled_services;
    expect(services.find((service) => service.service === 'frontend')?.public_url).toBe('https://app.cella.example');
    expect(services.find((service) => service.service === 'backend')?.public_url).toBe('https://app.cella.example/api');
  });
});
