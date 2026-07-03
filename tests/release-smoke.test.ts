import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');

describe('release package', () => {
  it('packs, installs, and runs the cella binary', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'cella-cli-pack-'));
    execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: repoRoot, stdio: 'pipe' });

    const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
    expect(tarball).toBeDefined();

    const appDir = mkdtempSync(join(tmpdir(), 'cella-cli-app-'));
    writeFileSync(join(appDir, 'package.json'), '{"type":"module"}\n');
    execFileSync('pnpm', ['add', join(packDir, tarball!)], { cwd: appDir, stdio: 'pipe' });
    writeFileSync(
      join(appDir, 'cella.config.ts'),
      [
        "import { defineConfig } from '@cellajs/cli/config';",
        '',
        'export default defineConfig({',
        '  settings: {',
        "    upstreamUrl: 'git@github.com:cellajs/cella.git',",
        "    upstreamBranch: 'main',",
        '  },',
        '});',
        '',
      ].join('\n'),
    );

    const output = execFileSync(join(appDir, 'node_modules/.bin/cella'), ['--help'], {
      cwd: appDir,
      encoding: 'utf8',
    });

    expect(output).toContain('Usage: cella [service] [options]');
  });
});
