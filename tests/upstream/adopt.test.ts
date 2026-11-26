import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runAdopt } from '../../src/upstream/adopt';
import { buildRuntimeConfig, createTestEnv, makeCommit } from '../helpers/test-env';

it("reads the other repository's ignored list without running its config", async () => {
  const env = createTestEnv();
  const marker = join(env.testDir, 'config-ran');
  try {
    // The app clone plays the other repository; its config would write the marker and throw if it ran
    makeCommit(env.repoRoot, {
      files: {
        'cella/cella.config.ts': [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(marker)}, 'ran');`,
          "throw new Error('the config ran');",
          "export default { ignored: ['own'] };",
        ].join('\n'),
        'own/secret.ts': 'export const s = 1;\n',
        'shared.ts': 'export const x = 1;\n',
      },
      message: 'feat: own module and a contribution',
    });
    const config = {
      ...buildRuntimeConfig(env),
      repoRoot: env.upstreamPath,
      forks: [{ name: 'app', localPath: '../app', pullBranch: 'main' }],
    };
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => written.push(String(chunk)) > 0);
    const exitCode = await runAdopt(config, { fork: 'app', json: true }).finally(() => stdout.mockRestore());
    const offered = JSON.parse(written.at(-1) ?? '[]').map((item: { path: string }) => item.path);

    expect(exitCode).toBe(0);

    expect(existsSync(marker)).toBe(false);
    expect(offered).toContain('shared.ts');
    expect(offered).not.toContain('own/secret.ts');
  } finally {
    env.cleanup();
  }
});
