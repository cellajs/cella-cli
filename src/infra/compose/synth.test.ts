import { describe, expect, it } from 'vitest';
import { composeConfig, services } from './compose';
import { renderCompose } from './synth';
import type { ComposeService } from './types';

describe('compose synth', () => {
  it('every logical service slug matches a compose profile', () => {
    const profiles = new Set<string>(Object.values(composeConfig.services).flatMap((s) => s.profiles));
    for (const meta of services) expect(profiles.has(meta.slug)).toBe(true);
  });

  it('published port equals the declared healthPort for each logical service', () => {
    for (const svc of Object.values(composeConfig.services)) {
      const meta = svc['x-service'];
      if (!meta || !svc.ports) continue;
      expect(svc.ports.some((port) => port.includes(String(meta.healthPort)))).toBe(true);
    }
  });

  it('folds every co-hosted service env onto the host block (singleVM in-process wiring)', () => {
    const host = Object.values(composeConfig.services).find((s) => s['x-service']?.primaryRollout);
    expect(host).toBeDefined();
    for (const svc of Object.values(composeConfig.services)) {
      const meta = svc['x-service'];
      if (!meta?.coHosted) continue;
      for (const [key, value] of Object.entries(svc.environment ?? {})) {
        // Process-identity keys stay off the host: SERVICE configures which entrypoint a
        // *container* boots; the folded workers boot in-process.
        if (key === 'SERVICE') {
          expect(host?.environment?.[key]).not.toBe(value);
          continue;
        }
        expect(host?.environment?.[key], `host env should carry co-hosted ${meta.slug}'s ${key}`).toBe(value);
      }
    }
  });
});

// The Compose file every machine of the fixture app runs: a rendering change shows in the engine's pull request as a change to this file
describe('the rendered Compose file', () => {
  it('of the fixture app is the recorded one, which `vitest -u` rewrites', async () => {
    await expect(renderCompose(composeConfig)).toMatchFileSnapshot('../tests/fixtures/app/compose.expected.yml');
  });

  const block: ComposeService = { image: 'r/x:latest', pull_policy: 'never', profiles: ['x'], restart: 'no' };
  const cases: [refusal: string, services: Record<string, ComposeService>][] = [
    // A line break in a key would add a key of its own, such as `privileged: true`
    ['an environment key holding a line break', { x: { ...block, environment: { 'A\nprivileged: true': 'v' } } }],
    ['a service name holding a carriage return', { 'x\rprivileged: true': block }],
  ];

  it.each(cases)('refuses %s', (_refusal, services) => {
    expect(() => renderCompose({ services })).toThrow(/holds a control character/);
  });
});
