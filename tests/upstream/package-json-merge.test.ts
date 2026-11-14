/**
 * Unit tests for package.json merge logic.
 *
 * Tests the three-way merge against the merge-base (add, follow upstream where the app never
 * touched an entry, keep the app's own changes) using real git repos with package.json files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageJsonKey, RuntimeConfig } from '../../src/config/types';
import { runPackages } from '../../src/upstream/package-json-merge';
import { getEffectiveMergeBase } from '../../src/upstream/upgrade-point';
import { commitAll, createTestEnv, exec, fetchUpstream, type TestEnv, write } from '../helpers/test-env';

/** A parsed package.json; the root one starts with both dependency records. */
type Pkg = Record<string, unknown> & { dependencies: Record<string, string>; devDependencies: Record<string, string> };

/** Read and parse package.json from a path */
function readPkg(dir: string, relativePath = ''): Pkg {
  return JSON.parse(fs.readFileSync(path.join(dir, relativePath, 'package.json'), 'utf-8'));
}

/** Write package.json to a path, creating its folder */
function writePkg(dir: string, data: Record<string, unknown>, relativePath = ''): void {
  write(dir, { [path.join(relativePath, 'package.json')]: `${JSON.stringify(data, null, 2)}\n` });
}

/** Change the package.json at `relativePath` in `repo`, then commit everything in the repo. */
function commitPkg(repo: string, mutate: (pkg: Pkg) => void, message: string, relativePath = ''): void {
  const pkg = readPkg(repo, relativePath);
  mutate(pkg);
  writePkg(repo, pkg, relativePath);
  commitAll(repo, message);
}

describe('packages merge', () => {
  let env: TestEnv;
  let upstreamPath: string;
  let repoRoot: string;

  beforeEach(() => {
    const rootPkg = {
      name: 'test-upstream',
      version: '1.0.0',
      dependencies: {
        hono: '^4.0.0',
        zod: '^3.22.0',
      },
      devDependencies: {
        vitest: '^1.0.0',
        typescript: '^5.3.0',
      },
    };
    // The upstream + app pair starts from a root package.json only
    env = createTestEnv({ files: { 'package.json': `${JSON.stringify(rootPkg, null, 2)}\n` } });
    upstreamPath = env.upstreamPath;
    repoRoot = env.repoRoot;
  });

  afterEach(() => {
    env.cleanup();
  });

  /** Merge package.json from upstream's main, against the merge base an upgrade would resolve. */
  async function mergePackages(options?: { packageJsonKeys?: PackageJsonKey[] }): Promise<void> {
    const config: RuntimeConfig = {
      upstreamUrl: upstreamPath,
      upstreamBranch: 'main',
      ...(options?.packageJsonKeys ? { packageJsonKeys: options.packageJsonKeys } : {}),
      pinned: [],
      ignored: [],
      repoRoot,
      upstreamRef: 'cella-upstream/main',
    };
    const ref = 'cella-upstream/main';
    await runPackages(config, { ref, mergeBase: await getEffectiveMergeBase(repoRoot, 'HEAD', ref) });
  }

  it('adds new dependencies from upstream in alphabetical order, at every package.json location', async () => {
    writePkg(upstreamPath, { name: 'frontend', dependencies: { react: '^18.0.0' } }, 'frontend');
    const added = { drizzle: '^0.30.0', axios: '^1.6.0' };
    commitPkg(upstreamPath, (pkg) => Object.assign(pkg.dependencies, added), 'add dependencies');
    writePkg(repoRoot, { name: 'frontend', dependencies: {} }, 'frontend');
    commitAll(repoRoot, 'add frontend package');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(Object.entries(readPkg(repoRoot).dependencies)).toEqual([
      ['axios', '^1.6.0'],
      ['drizzle', '^0.30.0'],
      ['hono', '^4.0.0'],
      ['zod', '^3.22.0'],
    ]);
    expect(readPkg(repoRoot, 'frontend').dependencies).toEqual({ react: '^18.0.0' });
  });

  it('never downgrades dependency versions', async () => {
    // Upstream still has ^4.0.0: the app's ^6.0.0 stays
    commitPkg(repoRoot, (pkg) => (pkg.dependencies.hono = '^6.0.0'), 'bump hono in app');

    await mergePackages();

    expect(readPkg(repoRoot).dependencies.hono).toBe('^6.0.0');
  });

  it('keeps the dependencies the app added or changed, also one upstream dropped', async () => {
    const appDeps = { 'my-custom-lib': '^1.0.0', zod: '^3.23.0' };
    commitPkg(repoRoot, (pkg) => Object.assign(pkg.dependencies, appDeps), 'add and bump in app');
    commitPkg(upstreamPath, (pkg) => delete pkg.dependencies.zod, 'remove zod');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot).dependencies).toEqual({ hono: '^4.0.0', 'my-custom-lib': '^1.0.0', zod: '^3.23.0' });
  });

  it('removes a dependency upstream dropped when the app never touched it', async () => {
    commitPkg(upstreamPath, (pkg) => delete pkg.dependencies.zod, 'remove zod');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot).dependencies).toEqual({ hono: '^4.0.0' });
  });

  it('keeps a dependency upstream dropped while app code still imports it', async () => {
    write(repoRoot, { 'src/schema.ts': "import { z } from 'zod/v4';\n" });
    commitAll(repoRoot, 'app schema');
    commitPkg(upstreamPath, (pkg) => delete pkg.dependencies.zod, 'remove zod');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot).dependencies.zod).toBe('^3.22.0');
  });

  it('keeps a devDependency whose CLI an app script runs, by the bin name it installs', async () => {
    commitPkg(repoRoot, (pkg) => (pkg.scripts = { typecheck: 'tsc --noEmit' }), 'app typecheck script');
    // Installed (untracked): the bin names come from here
    const typescript = { name: 'typescript', bin: { tsc: './bin/tsc', tsserver: './bin/tsserver' } };
    writePkg(repoRoot, typescript, 'node_modules/typescript');
    commitPkg(upstreamPath, (pkg) => (pkg.devDependencies = {}), 'drop dev dependencies');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot).devDependencies).toEqual({ typescript: '^5.3.0' });
  });

  it('only counts app code inside the workspace whose dependency upstream dropped', async () => {
    writePkg(upstreamPath, { name: 'backend', dependencies: { 'pg-format': '^1.0.0', postgres: '^3.4.0' } }, 'backend');
    commitAll(upstreamPath, 'add backend');
    exec('git pull --ff-only cella-upstream main', repoRoot);

    write(repoRoot, {
      'frontend/query.ts': "import format from 'pg-format';\n",
      'backend/db.ts': "import postgres from 'postgres';\n",
    });
    commitAll(repoRoot, 'app modules');
    commitPkg(upstreamPath, (pkg) => (pkg.dependencies = {}), 'drop backend dependencies', 'backend');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot, 'backend').dependencies).toEqual({ postgres: '^3.4.0' });
  });

  it('does not re-add a dependency the app removed', async () => {
    commitPkg(repoRoot, (pkg) => delete pkg.dependencies.zod, 'drop zod in app');
    commitPkg(upstreamPath, (pkg) => (pkg.dependencies.hono = '^5.0.0'), 'bump hono');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot).dependencies).toEqual({ hono: '^5.0.0' });
  });

  it('follows an upstream range change the app never touched, a bump or a downgrade', async () => {
    const ranges = { hono: '^3.12.0', zod: '^3.23.0' };
    commitPkg(upstreamPath, (pkg) => Object.assign(pkg.dependencies, ranges), 'pin hono lower, bump zod');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot).dependencies).toEqual({ hono: '^3.12.0', zod: '^3.23.0' });
  });

  it('updates a script the app never touched, keeps one it changed and adds a new one', async () => {
    // Base: upstream ships scripts, the app takes them as they are
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = { build: 'tsc', lint: 'biome check .' }), 'add scripts');
    exec('git pull --ff-only cella-upstream main', repoRoot);

    // App rewrites lint; upstream rewrites both and adds test
    commitPkg(repoRoot, (pkg) => (pkg.scripts = { build: 'tsc', lint: 'my-linter' }), 'own linter');
    const rewritten = { build: 'tsc -b', lint: 'biome check --write .', test: 'vitest' };
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = rewritten), 'rewrite scripts');
    fetchUpstream(repoRoot);

    await mergePackages({ packageJsonKeys: ['dependencies', 'devDependencies', 'scripts'] });

    expect(readPkg(repoRoot).scripts).toEqual({ build: 'tsc -b', lint: 'my-linter', test: 'vitest' });
  });

  it("keeps upstream's script order, with the app's own scripts where the app put them", async () => {
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = { dev: 'vite', build: 'tsc', test: 'vitest' }), 'add scripts');
    exec('git pull --ff-only cella-upstream main', repoRoot);

    // Sorted by an earlier upgrade, plus a script of the app's own after `test`
    const appScripts = { build: 'tsc', dev: 'vite', test: 'vitest', 'test:update': 'vitest -u' };
    commitPkg(repoRoot, (pkg) => (pkg.scripts = appScripts), 'own script');
    const upstreamScripts = { dev: 'vite', build: 'tsc -b', test: 'vitest', lint: 'biome check .' };
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = upstreamScripts), 'add lint');
    fetchUpstream(repoRoot);

    await mergePackages({ packageJsonKeys: ['dependencies', 'devDependencies', 'scripts'] });

    expect(Object.keys(readPkg(repoRoot).scripts ?? {})).toEqual(['dev', 'build', 'test', 'test:update', 'lint']);
  });

  it('removes a script upstream dropped unless an app file still runs it', async () => {
    const scripts = { build: 'tsc', 'geoip:download': 'node geoip.js', 'old:task': 'node old.js' };
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = scripts), 'add scripts');
    exec('git pull --ff-only cella-upstream main', repoRoot);

    write(repoRoot, { '.github/workflows/geoip.yml': 'steps:\n  - run: pnpm --filter backend geoip:download\n' });
    commitAll(repoRoot, 'app workflow');
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = { build: 'tsc' }), 'drop scripts');
    fetchUpstream(repoRoot);

    await mergePackages({ packageJsonKeys: ['dependencies', 'devDependencies', 'scripts'] });

    expect(readPkg(repoRoot).scripts).toEqual({ build: 'tsc', 'geoip:download': 'node geoip.js' });
  });

  it('copies the package.json of a workspace upstream added since the base', async () => {
    writePkg(upstreamPath, { name: 'oauth', dependencies: { hono: '^4.0.0' } }, 'oauth');
    write(upstreamPath, { 'oauth/index.ts': 'export {};\n' });
    commitAll(upstreamPath, 'add oauth workspace');
    fetchUpstream(repoRoot);

    // The file merge brought the workspace without its (always ignored) package.json
    write(repoRoot, { 'oauth/index.ts': 'export {};\n' });

    await mergePackages();

    const raw = fs.readFileSync(path.join(repoRoot, 'oauth', 'package.json'), 'utf-8');
    expect(raw).toBe(exec('git show cella-upstream/main:oauth/package.json', repoRoot).concat('\n'));
  });

  it('leaves out a workspace package.json the app deleted since the base', async () => {
    writePkg(upstreamPath, { name: 'sdk', dependencies: {} }, 'sdk');
    write(upstreamPath, { 'sdk/index.ts': 'export {};\n' });
    commitAll(upstreamPath, 'add sdk workspace');
    exec('git pull --ff-only cella-upstream main', repoRoot);
    exec('git rm -q sdk/package.json && git commit -m "drop sdk package"', repoRoot);

    commitPkg(upstreamPath, (pkg) => (pkg.dependencies.hono = '^5.0.0'), 'bump hono');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(fs.existsSync(path.join(repoRoot, 'sdk', 'package.json'))).toBe(false);
  });

  it('adds new export subpaths from upstream but keeps app subpaths and order', async () => {
    const appExports = { './app-only': './dist/app.js', '.': './dist/custom.js' };
    commitPkg(repoRoot, (pkg) => (pkg.exports = appExports), 'add app exports');
    const config = { types: './dist/config.d.ts', import: './dist/config.js' };
    commitPkg(upstreamPath, (pkg) => (pkg.exports = { '.': './dist/index.js', './config': config }), 'add exports');
    fetchUpstream(repoRoot);

    await mergePackages({ packageJsonKeys: ['dependencies', 'exports'] });

    const exportsMap = readPkg(repoRoot).exports as Record<string, unknown>;
    // Repointed subpath stays repointed, new subpath arrives with its conditions in upstream order
    expect(exportsMap['.']).toBe('./dist/custom.js');
    expect(Object.keys(exportsMap)).toEqual(['./app-only', '.', './config']);
    expect(Object.keys(exportsMap['./config'] as object)).toEqual(['types', 'import']);
  });

  it('leaves exports alone when either side is not a subpath map', async () => {
    commitPkg(repoRoot, (pkg) => (pkg.exports = './dist/index.js'), 'add app exports');
    const subpaths = { '.': './dist/index.js', './config': './dist/config.js' };
    commitPkg(upstreamPath, (pkg) => (pkg.exports = subpaths), 'add exports');
    fetchUpstream(repoRoot);

    await mergePackages({ packageJsonKeys: ['dependencies', 'exports'] });

    expect(readPkg(repoRoot).exports).toBe('./dist/index.js');
  });

  it('adds an upstream type the app never got, after name and version, whatever packageJsonKeys lists', async () => {
    const { name, version, dependencies, devDependencies } = readPkg(upstreamPath);
    writePkg(upstreamPath, { name, version, type: 'module', dependencies, devDependencies });
    commitAll(upstreamPath, 'esm');
    // The app upgraded past it, but package.json never carried `type` over: the base has it, the app lacks it
    exec('git pull --ff-only cella-upstream main', repoRoot);
    writePkg(repoRoot, { name, version, dependencies, devDependencies });
    commitAll(repoRoot, 'app copy without type');

    commitPkg(upstreamPath, (pkg) => (pkg.dependencies.hono = '^5.0.0'), 'bump hono');
    fetchUpstream(repoRoot);
    const info = vi.spyOn(console, 'info');

    await mergePackages({ packageJsonKeys: ['dependencies'] });

    const resultPkg = readPkg(repoRoot);
    expect(resultPkg.type).toBe('module');
    expect(Object.keys(resultPkg)).toEqual(['name', 'version', 'type', 'dependencies', 'devDependencies']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('type: added'));
    info.mockRestore();
  });

  it('follows an upstream type change the app never touched and keeps a type the app set', async () => {
    writePkg(upstreamPath, { ...readPkg(upstreamPath), type: 'module' });
    writePkg(upstreamPath, { name: 'backend', type: 'module', dependencies: {} }, 'backend');
    commitAll(upstreamPath, 'esm');
    exec('git pull --ff-only cella-upstream main', repoRoot);
    commitPkg(repoRoot, (pkg) => (pkg.type = 'commonjs'), 'app backend on cjs', 'backend');

    // Upstream moves the root to commonjs and leaves backend on module
    writePkg(upstreamPath, { name: 'backend', type: 'module', dependencies: { hono: '^4.0.0' } }, 'backend');
    commitPkg(upstreamPath, (pkg) => (pkg.type = 'commonjs'), 'root on cjs');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot).type).toBe('commonjs');
    expect(readPkg(repoRoot, 'backend').type).toBe('commonjs');
  });

  it('removes a type upstream dropped when the app never touched it', async () => {
    commitPkg(upstreamPath, (pkg) => (pkg.type = 'module'), 'esm');
    exec('git pull --ff-only cella-upstream main', repoRoot);
    commitPkg(upstreamPath, (pkg) => delete pkg.type, 'drop type');
    fetchUpstream(repoRoot);

    await mergePackages();

    expect(readPkg(repoRoot)).not.toHaveProperty('type');
  });

  it('follows a packageManager the app never touched and keeps one the app changed', async () => {
    writePkg(upstreamPath, { name: 'backend', packageManager: 'pnpm@10.0.0' }, 'backend');
    commitPkg(upstreamPath, (pkg) => (pkg.packageManager = 'pnpm@10.0.0'), 'pin pnpm');
    exec('git pull --ff-only cella-upstream main', repoRoot);
    commitPkg(repoRoot, (pkg) => (pkg.packageManager = 'pnpm@10.5.0'), 'app backend on a newer pnpm', 'backend');

    writePkg(upstreamPath, { name: 'backend', packageManager: 'pnpm@10.2.0' }, 'backend');
    commitPkg(upstreamPath, (pkg) => (pkg.packageManager = 'pnpm@10.2.0'), 'bump pnpm');
    fetchUpstream(repoRoot);

    await mergePackages({ packageJsonKeys: ['packageManager'] });

    expect(readPkg(repoRoot).packageManager).toBe('pnpm@10.2.0');
    expect(readPkg(repoRoot, 'backend').packageManager).toBe('pnpm@10.5.0');
  });

  it('merges pnpm.overrides with add/bump-only logic', async () => {
    const appOverrides = { 'esbuild@<=0.24.2': '>=0.25.0', 'app-only-pkg@<1.0.0': '>=1.0.0' };
    commitPkg(repoRoot, (pkg) => (pkg.pnpm = { overrides: appOverrides }), 'add pnpm overrides');
    // Upstream bumps one override and adds one
    const upstreamOverrides = { 'esbuild@<=0.24.2': '>=0.26.0', 'hono@<4.12.7': '>=4.12.7' };
    commitPkg(upstreamPath, (pkg) => (pkg.pnpm = { overrides: upstreamOverrides }), 'add pnpm overrides');
    fetchUpstream(repoRoot);

    await mergePackages({ packageJsonKeys: ['dependencies', 'devDependencies', 'pnpm'] });

    expect(readPkg(repoRoot).pnpm).toEqual({
      overrides: { 'esbuild@<=0.24.2': '>=0.26.0', 'app-only-pkg@<1.0.0': '>=1.0.0', 'hono@<4.12.7': '>=4.12.7' },
    });
  });

  it('merges pnpm.patchedDependencies and pnpm.packageExtensions add-only', async () => {
    const appPnpm = {
      patchedDependencies: { 'slugify@1.6.6': 'patches/slugify@1.6.6.patch' },
      packageExtensions: { '@hookform/resolvers@5.2.2': { peerDependencies: { zod: '*' } } },
    };
    commitPkg(repoRoot, (pkg) => (pkg.pnpm = appPnpm), 'add app patch and extension');
    const upstreamPnpm = {
      patchedDependencies: { 'dexie@4.3.0': 'patches/dexie@4.3.0.patch' },
      packageExtensions: { 'some-lib@1.0.0': { peerDependencies: { react: '*' } } },
    };
    commitPkg(upstreamPath, (pkg) => (pkg.pnpm = upstreamPnpm), 'add upstream patch and extension');
    fetchUpstream(repoRoot);

    await mergePackages({ packageJsonKeys: ['dependencies', 'devDependencies', 'pnpm'] });

    expect(readPkg(repoRoot).pnpm).toEqual({
      patchedDependencies: { ...appPnpm.patchedDependencies, ...upstreamPnpm.patchedDependencies },
      packageExtensions: { ...appPnpm.packageExtensions, ...upstreamPnpm.packageExtensions },
    });
  });

  it('fails on an app package.json that does not parse, and leaves the file as it is', async () => {
    // A workspace upstream added since the base, where an app without the package.json gets upstream's copy
    writePkg(upstreamPath, { name: 'oauth', dependencies: {} }, 'oauth');
    commitAll(upstreamPath, 'add oauth workspace');
    fetchUpstream(repoRoot);
    write(repoRoot, { 'oauth/package.json': '{ "name": ' });

    await expect(mergePackages()).rejects.toThrow(/cannot parse .*oauth\/package\.json/);
    expect(fs.readFileSync(path.join(repoRoot, 'oauth', 'package.json'), 'utf-8')).toBe('{ "name": ');
  });
});
