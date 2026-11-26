import { execSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { fetchUpstream, resolveUpstreamRef } from '../../src/upstream/upstream-ref';
import { buildRuntimeConfig, createTestEnv, makeCommit, tagUpstream } from '../helpers/test-env';

it('takes the highest release on the upstream branch, not a higher tag on a side branch', async () => {
  const env = createTestEnv();
  try {
    makeCommit(env.upstreamPath, { files: { 'released.ts': 'export const r = 1;\n' }, message: 'feat: released' });
    tagUpstream(env.upstreamPath, '0.50.0');
    execSync('git checkout -q -b side && git commit -q --allow-empty -m side', { cwd: env.upstreamPath });
    tagUpstream(env.upstreamPath, '0.99.0');
    execSync('git checkout -q main', { cwd: env.upstreamPath });
    const config = buildRuntimeConfig(env, { track: 'release' });
    await fetchUpstream(config);

    expect(await resolveUpstreamRef(config)).toMatchObject({ releaseTag: '0.50.0' });
  } finally {
    env.cleanup();
  }
});

it('takes a release over a pre-release of it on the branch tip', async () => {
  const env = createTestEnv();
  try {
    tagUpstream(env.upstreamPath, '0.49.0');
    makeCommit(env.upstreamPath, { files: { 'next.ts': 'export const n = 1;\n' }, message: 'feat: next' });
    tagUpstream(env.upstreamPath, '0.49.0-rc.1');
    const config = buildRuntimeConfig(env, { track: 'release' });
    await fetchUpstream(config);

    expect(await resolveUpstreamRef(config)).toMatchObject({ releaseTag: '0.49.0' });
  } finally {
    env.cleanup();
  }
});
