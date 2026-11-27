import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** The runtime names each subpath exports, which apps import: a name leaves only in a major release. */
const subpathExports: Record<string, string[]> = {
  './config': ['defineConfig'],
  './bench': ['defineScenario', 'distributionOf', 'runBench'],
  './style': ['classTexts', 'classTokens', 'isClassSource', 'lineColumn', 'loadTailwindNode', 'parseSource', 'repoFiles', 'splitToken'],
  './drive': ['loadPlaywright', 'mintSession', 'signOut'],
  './a11y': ['auditContrast', 'defineA11yApp', 'defineA11yBase', 'openState', 'settle'],
  './screenshots': ['defineScreenshotsApp', 'defineScreenshotsBase'],
  './pentest': ['definePentestApp', 'definePentestBase'],
  // An app's infra workspace runs these: the Pulumi program, and the engine its own tests check files against
  './infra/program': [],
  './infra/contract': [
    'appServices',
    'documentedTasks',
    'engineAssetsDir',
    'isOperatorActionId',
    'menuRow',
    'menuRows',
    'operatorActions',
    'redirectedApexOrigin',
    'runtimeSecretConsumers',
    'runtimeSecrets',
    'runtimeSecretsForConsumer',
  ],
};

/** The subpaths that name one file: the JSON Schema of `cella/infra/description.yml`, which an app's editor validates the file with. */
const fileExports = ['./infra/description.schema.json'];

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
    // The contract reads the app's description when it loads
    mkdirSync(join(appDir, 'cella/infra'), { recursive: true });
    copyFileSync(join(repoRoot, 'src/infra/tests/fixtures/app/cella/infra/description.yml'), join(appDir, 'cella/infra/description.yml'));
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
    expect(subpaths.sort()).toEqual([...Object.keys(subpathExports), ...fileExports].sort());
    for (const subpath of subpaths) {
      const target: string | { import: string; types: string } = exports[subpath];
      for (const file of typeof target === 'string' ? [target] : [target.import, target.types]) {
        expect(existsSync(join(packageDir, file)), file).toBe(true);
      }
    }
  });

  // An app's editor validates its description with the shipped schema: one stricter than the engine's load marks a valid file wrong
  it("ships a description JSON Schema that accepts the fixture app's description", () => {
    const { exports } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const schema = JSON.parse(readFileSync(join(packageDir, exports['./infra/description.schema.json']), 'utf8'));
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    const description = parse(readFileSync(join(repoRoot, 'src/infra/tests/fixtures/app/cella/infra/description.yml'), 'utf8'));
    expect(validate(description), JSON.stringify(validate.errors)).toBe(true);
  });

  // The Pulumi program runs only under Pulumi
  const loadsAlone = Object.entries(subpathExports).filter(([subpath]) => subpath !== './infra/program');
  it.each(loadsAlone)('%s exports its names', (subpath, names) => {
    const specifier = `@cellajs/cli${subpath.slice(1)}`;
    const script = `console.log(JSON.stringify(Object.keys(await import('${specifier}'))))`;
    const exported: string[] = JSON.parse(run(process.execPath, ['--input-type=module', '-e', script]));
    expect(exported.sort()).toEqual([...names].sort());
  });
});
