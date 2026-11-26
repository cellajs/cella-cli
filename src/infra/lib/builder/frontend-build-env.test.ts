import { describe, expect, it } from 'vitest';
import { frontendBuildEnv } from './frontend-build-env';

describe('frontendBuildEnv', () => {
  it('emits APP_MODE, the config-loader origin override from enabled services JSON and the release', () => {
    const rows = [
      { service: 'backend', public_url: 'https://app.example/api' },
      { service: 'frontend', public_url: 'https://app.example' },
      { service: 'cdc', public_url: '' },
    ];
    expect(frontendBuildEnv('staging', rows, 'abc123')).toEqual({ APP_MODE: 'staging', APP_ORIGIN: 'https://app.example', RELEASE_SHA: 'abc123' });
  });

  it('throws when the frontend public URL is absent', () => {
    expect(() => frontendBuildEnv('production', [{ service: 'backend', public_url: 'https://app.example/api' }], 'abc123')).toThrow(/frontend/);
  });
});
