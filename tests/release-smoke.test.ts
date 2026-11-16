import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The runtime names each subpath exports, which apps import: a name leaves only in a major release. */
const subpathExports: Record<string, string[]> = {
  './config': ['defineConfig'],
  './bench': ['defineScenario', 'distributionOf', 'runBench'],
  './style': [
    'classTexts',
    'classTokens',
    'isClassSource',
    'lineColumn',
    'loadTailwindNode',
    'parseSource',
    'repoFiles',
    'splitToken',
  ],
  './drive': ['loadPlaywright', 'mintSession', 'signOut'],
  './a11y': ['auditContrast', 'defineA11yApp', 'defineA11yBase', 'openState', 'settle'],
  './screenshots': ['defineScreenshotsApp', 'defineScreenshotsBase'],
  './pentest': ['definePentestApp', 'definePentestBase'],
};

/**
 * Packs this package and installs the tarball into a throwaway app, so every check runs the files and the dependency
 * closure a published install gets. `test:release` and `prepublishOnly` run it; the default `pnpm test` leaves it out.
 */
describe('release package', () => {
  const repoRoot = resolve(import.meta.dirname, '..');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cella-cli-release-'));
  const appDir = join(tempRoot, 'app');
  const packageDir = join(appDir, 'node_modules/@cellajs/cli');
  const run = (file: string, args: string[]) => execFileSync(file, args, { cwd: appDir, encoding: 'utf8' });

  beforeAll(() => {
    execFileSync('pnpm', ['pack', '--pack-destination', tempRoot], { cwd: repoRoot, stdio: 'pipe' });
    const tarball = readdirSync(tempRoot).find((file) => file.endsWith('.tgz'));
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'package.json'), '{"type":"module"}\n');
    execFileSync('pnpm', ['add', join(tempRoot, tarball!)], { cwd: appDir, stdio: 'pipe' });
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('starts the bin', () => {
    const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const bin = join(appDir, 'node_modules/.bin/cella');
    expect(run(bin, ['--help'])).toContain('Usage: cella [command] [options]');
    expect(run(bin, ['--version']).trim()).toBe(version);
  });

  it('ships the built files of every subpath in exports, and the table names each one', () => {
    const { exports } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const subpaths = Object.keys(exports).filter((subpath) => subpath !== './package.json');
    expect(subpaths.sort()).toEqual(Object.keys(subpathExports).sort());
    for (const subpath of subpaths) {
      expect(existsSync(join(packageDir, exports[subpath].import)), exports[subpath].import).toBe(true);
      expect(existsSync(join(packageDir, exports[subpath].types)), exports[subpath].types).toBe(true);
    }
  });

  it.each(Object.entries(subpathExports))('%s exports its names', (subpath, names) => {
    const specifier = `@cellajs/cli${subpath.slice(1)}`;
    const script = `console.log(JSON.stringify(Object.keys(await import('${specifier}'))))`;
    const exported: string[] = JSON.parse(run(process.execPath, ['--input-type=module', '-e', script]));
    expect(exported.sort()).toEqual([...names].sort());
  });
});
