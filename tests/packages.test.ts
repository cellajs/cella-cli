/**
 * Unit tests for package.json merge logic.
 *
 * Tests the three-way merge against the merge-base (add, follow upstream where the fork never
 * touched an entry, keep the fork's own changes) using real git repos with package.json files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageJsonKey, RuntimeConfig } from '../src/config/types';
import { runPackages } from '../src/services/packages';
import { commitAll, createTestEnv, exec, fetchUpstream, type TestEnv, write } from './helpers/test-env';

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
  let forkPath: string;

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
    // The upstream + fork pair starts from a root package.json only
    env = createTestEnv({ files: { 'package.json': `${JSON.stringify(rootPkg, null, 2)}\n` } });
    upstreamPath = env.upstreamPath;
    forkPath = env.forkPath;
  });

  afterEach(() => {
    env.cleanup();
  });

  /** Build a RuntimeConfig for the packages service */
  function buildConfig(options?: { packageJsonKeys?: PackageJsonKey[] }): RuntimeConfig {
    return {
      settings: {
        upstreamUrl: upstreamPath,
        upstreamBranch: 'main',
        ...(options?.packageJsonKeys ? { packageJsonKeys: options.packageJsonKeys } : {}),
      },
      overrides: { pinned: [], ignored: [] },
      forkPath,
      upstreamRef: 'cella-upstream/main',
      service: 'upgrade',
      list: false,
      json: false,
      verbose: false,
    };
  }

  it('adds new dependencies from upstream in alphabetical order, at every package.json location', async () => {
    writePkg(upstreamPath, { name: 'frontend', dependencies: { react: '^18.0.0' } }, 'frontend');
    const added = { drizzle: '^0.30.0', axios: '^1.6.0' };
    commitPkg(upstreamPath, (pkg) => Object.assign(pkg.dependencies, added), 'add dependencies');
    writePkg(forkPath, { name: 'frontend', dependencies: {} }, 'frontend');
    commitAll(forkPath, 'add frontend package');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(Object.entries(readPkg(forkPath).dependencies)).toEqual([
      ['axios', '^1.6.0'],
      ['drizzle', '^0.30.0'],
      ['hono', '^4.0.0'],
      ['zod', '^3.22.0'],
    ]);
    expect(readPkg(forkPath, 'frontend').dependencies).toEqual({ react: '^18.0.0' });
  });

  it('never downgrades dependency versions', async () => {
    // Upstream still has ^4.0.0: the fork's ^6.0.0 stays
    commitPkg(forkPath, (pkg) => (pkg.dependencies.hono = '^6.0.0'), 'bump hono in fork');

    await runPackages(buildConfig());

    expect(readPkg(forkPath).dependencies.hono).toBe('^6.0.0');
  });

  it('keeps the dependencies the fork added or changed, also one upstream dropped', async () => {
    const forkDeps = { 'my-custom-lib': '^1.0.0', zod: '^3.23.0' };
    commitPkg(forkPath, (pkg) => Object.assign(pkg.dependencies, forkDeps), 'add and bump in fork');
    commitPkg(upstreamPath, (pkg) => delete pkg.dependencies.zod, 'remove zod');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath).dependencies).toEqual({ hono: '^4.0.0', 'my-custom-lib': '^1.0.0', zod: '^3.23.0' });
  });

  it('removes a dependency upstream dropped when the fork never touched it', async () => {
    commitPkg(upstreamPath, (pkg) => delete pkg.dependencies.zod, 'remove zod');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath).dependencies).toEqual({ hono: '^4.0.0' });
  });

  it('keeps a dependency upstream dropped while fork code still imports it', async () => {
    write(forkPath, { 'src/schema.ts': "import { z } from 'zod/v4';\n" });
    commitAll(forkPath, 'fork schema');
    commitPkg(upstreamPath, (pkg) => delete pkg.dependencies.zod, 'remove zod');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath).dependencies.zod).toBe('^3.22.0');
  });

  it('keeps a devDependency whose CLI a fork script runs, by the bin name it installs', async () => {
    commitPkg(forkPath, (pkg) => (pkg.scripts = { typecheck: 'tsc --noEmit' }), 'fork typecheck script');
    // Installed (untracked): the bin names come from here
    const typescript = { name: 'typescript', bin: { tsc: './bin/tsc', tsserver: './bin/tsserver' } };
    writePkg(forkPath, typescript, 'node_modules/typescript');
    commitPkg(upstreamPath, (pkg) => (pkg.devDependencies = {}), 'drop dev dependencies');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath).devDependencies).toEqual({ typescript: '^5.3.0' });
  });

  it('only counts fork code inside the workspace whose dependency upstream dropped', async () => {
    writePkg(upstreamPath, { name: 'backend', dependencies: { 'pg-format': '^1.0.0', postgres: '^3.4.0' } }, 'backend');
    commitAll(upstreamPath, 'add backend');
    exec('git pull --ff-only cella-upstream main', forkPath);

    write(forkPath, {
      'frontend/query.ts': "import format from 'pg-format';\n",
      'backend/db.ts': "import postgres from 'postgres';\n",
    });
    commitAll(forkPath, 'fork modules');
    commitPkg(upstreamPath, (pkg) => (pkg.dependencies = {}), 'drop backend dependencies', 'backend');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath, 'backend').dependencies).toEqual({ postgres: '^3.4.0' });
  });

  it('does not re-add a dependency the fork removed', async () => {
    commitPkg(forkPath, (pkg) => delete pkg.dependencies.zod, 'drop zod in fork');
    commitPkg(upstreamPath, (pkg) => (pkg.dependencies.hono = '^5.0.0'), 'bump hono');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath).dependencies).toEqual({ hono: '^5.0.0' });
  });

  it('follows an upstream range change the fork never touched, a bump or a downgrade', async () => {
    const ranges = { hono: '^3.12.0', zod: '^3.23.0' };
    commitPkg(upstreamPath, (pkg) => Object.assign(pkg.dependencies, ranges), 'pin hono lower, bump zod');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath).dependencies).toEqual({ hono: '^3.12.0', zod: '^3.23.0' });
  });

  it('updates a script the fork never touched, keeps one it changed and adds a new one', async () => {
    // Base: upstream ships scripts, the fork takes them as they are
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = { build: 'tsc', lint: 'biome check .' }), 'add scripts');
    exec('git pull --ff-only cella-upstream main', forkPath);

    // Fork rewrites lint; upstream rewrites both and adds test
    commitPkg(forkPath, (pkg) => (pkg.scripts = { build: 'tsc', lint: 'my-linter' }), 'own linter');
    const rewritten = { build: 'tsc -b', lint: 'biome check --write .', test: 'vitest' };
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = rewritten), 'rewrite scripts');
    fetchUpstream(forkPath);

    await runPackages(buildConfig({ packageJsonKeys: ['dependencies', 'devDependencies', 'scripts'] }));

    expect(readPkg(forkPath).scripts).toEqual({ build: 'tsc -b', lint: 'my-linter', test: 'vitest' });
  });

  it("keeps upstream's script order, with the fork's own scripts where the fork put them", async () => {
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = { dev: 'vite', build: 'tsc', test: 'vitest' }), 'add scripts');
    exec('git pull --ff-only cella-upstream main', forkPath);

    // Sorted by an earlier sync, plus a script of the fork's own after `test`
    const forkScripts = { build: 'tsc', dev: 'vite', test: 'vitest', 'test:update': 'vitest -u' };
    commitPkg(forkPath, (pkg) => (pkg.scripts = forkScripts), 'own script');
    const upstreamScripts = { dev: 'vite', build: 'tsc -b', test: 'vitest', lint: 'biome check .' };
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = upstreamScripts), 'add lint');
    fetchUpstream(forkPath);

    await runPackages(buildConfig({ packageJsonKeys: ['dependencies', 'devDependencies', 'scripts'] }));

    expect(Object.keys(readPkg(forkPath).scripts ?? {})).toEqual(['dev', 'build', 'test', 'test:update', 'lint']);
  });

  it('removes a script upstream dropped unless a fork file still runs it', async () => {
    const scripts = { build: 'tsc', 'geoip:download': 'node geoip.js', 'old:task': 'node old.js' };
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = scripts), 'add scripts');
    exec('git pull --ff-only cella-upstream main', forkPath);

    write(forkPath, { '.github/workflows/geoip.yml': 'steps:\n  - run: pnpm --filter backend geoip:download\n' });
    commitAll(forkPath, 'fork workflow');
    commitPkg(upstreamPath, (pkg) => (pkg.scripts = { build: 'tsc' }), 'drop scripts');
    fetchUpstream(forkPath);

    await runPackages(buildConfig({ packageJsonKeys: ['dependencies', 'devDependencies', 'scripts'] }));

    expect(readPkg(forkPath).scripts).toEqual({ build: 'tsc', 'geoip:download': 'node geoip.js' });
  });

  it('copies the package.json of a workspace upstream added since the base', async () => {
    writePkg(upstreamPath, { name: 'oauth', dependencies: { hono: '^4.0.0' } }, 'oauth');
    write(upstreamPath, { 'oauth/index.ts': 'export {};\n' });
    commitAll(upstreamPath, 'add oauth workspace');
    fetchUpstream(forkPath);

    // The file merge brought the workspace without its (always ignored) package.json
    write(forkPath, { 'oauth/index.ts': 'export {};\n' });

    await runPackages(buildConfig());

    const raw = fs.readFileSync(path.join(forkPath, 'oauth', 'package.json'), 'utf-8');
    expect(raw).toBe(exec('git show cella-upstream/main:oauth/package.json', forkPath).concat('\n'));
  });

  it('leaves out a workspace package.json the fork deleted since the base', async () => {
    writePkg(upstreamPath, { name: 'sdk', dependencies: {} }, 'sdk');
    write(upstreamPath, { 'sdk/index.ts': 'export {};\n' });
    commitAll(upstreamPath, 'add sdk workspace');
    exec('git pull --ff-only cella-upstream main', forkPath);
    exec('git rm -q sdk/package.json && git commit -m "drop sdk package"', forkPath);

    commitPkg(upstreamPath, (pkg) => (pkg.dependencies.hono = '^5.0.0'), 'bump hono');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(fs.existsSync(path.join(forkPath, 'sdk', 'package.json'))).toBe(false);
  });

  it('adds new export subpaths from upstream but keeps fork subpaths and order', async () => {
    const forkExports = { './fork-only': './dist/fork.js', '.': './dist/custom.js' };
    commitPkg(forkPath, (pkg) => (pkg.exports = forkExports), 'add fork exports');
    const config = { types: './dist/config.d.ts', import: './dist/config.js' };
    commitPkg(upstreamPath, (pkg) => (pkg.exports = { '.': './dist/index.js', './config': config }), 'add exports');
    fetchUpstream(forkPath);

    await runPackages(buildConfig({ packageJsonKeys: ['dependencies', 'exports'] }));

    const exportsMap = readPkg(forkPath).exports as Record<string, unknown>;
    // Repointed subpath stays repointed, new subpath arrives with its conditions in upstream order
    expect(exportsMap['.']).toBe('./dist/custom.js');
    expect(Object.keys(exportsMap)).toEqual(['./fork-only', '.', './config']);
    expect(Object.keys(exportsMap['./config'] as object)).toEqual(['types', 'import']);
  });

  it('leaves exports alone when either side is not a subpath map', async () => {
    commitPkg(forkPath, (pkg) => (pkg.exports = './dist/index.js'), 'add fork exports');
    const subpaths = { '.': './dist/index.js', './config': './dist/config.js' };
    commitPkg(upstreamPath, (pkg) => (pkg.exports = subpaths), 'add exports');
    fetchUpstream(forkPath);

    await runPackages(buildConfig({ packageJsonKeys: ['dependencies', 'exports'] }));

    expect(readPkg(forkPath).exports).toBe('./dist/index.js');
  });

  it('adds an upstream type the fork never got, after name and version, whatever packageJsonKeys lists', async () => {
    const { name, version, dependencies, devDependencies } = readPkg(upstreamPath);
    writePkg(upstreamPath, { name, version, type: 'module', dependencies, devDependencies });
    commitAll(upstreamPath, 'esm');
    // The fork synced past it, but package.json never carried `type` over: the base has it, the fork lacks it
    exec('git pull --ff-only cella-upstream main', forkPath);
    writePkg(forkPath, { name, version, dependencies, devDependencies });
    commitAll(forkPath, 'fork copy without type');

    commitPkg(upstreamPath, (pkg) => (pkg.dependencies.hono = '^5.0.0'), 'bump hono');
    fetchUpstream(forkPath);
    const info = vi.spyOn(console, 'info');

    await runPackages(buildConfig({ packageJsonKeys: ['dependencies'] }));

    const resultPkg = readPkg(forkPath);
    expect(resultPkg.type).toBe('module');
    expect(Object.keys(resultPkg)).toEqual(['name', 'version', 'type', 'dependencies', 'devDependencies']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('type: added'));
    info.mockRestore();
  });

  it('follows an upstream type change the fork never touched and keeps a type the fork set', async () => {
    writePkg(upstreamPath, { ...readPkg(upstreamPath), type: 'module' });
    writePkg(upstreamPath, { name: 'backend', type: 'module', dependencies: {} }, 'backend');
    commitAll(upstreamPath, 'esm');
    exec('git pull --ff-only cella-upstream main', forkPath);
    commitPkg(forkPath, (pkg) => (pkg.type = 'commonjs'), 'fork backend on cjs', 'backend');

    // Upstream moves the root to commonjs and leaves backend on module
    writePkg(upstreamPath, { name: 'backend', type: 'module', dependencies: { hono: '^4.0.0' } }, 'backend');
    commitPkg(upstreamPath, (pkg) => (pkg.type = 'commonjs'), 'root on cjs');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath).type).toBe('commonjs');
    expect(readPkg(forkPath, 'backend').type).toBe('commonjs');
  });

  it('removes a type upstream dropped when the fork never touched it', async () => {
    commitPkg(upstreamPath, (pkg) => (pkg.type = 'module'), 'esm');
    exec('git pull --ff-only cella-upstream main', forkPath);
    commitPkg(upstreamPath, (pkg) => delete pkg.type, 'drop type');
    fetchUpstream(forkPath);

    await runPackages(buildConfig());

    expect(readPkg(forkPath)).not.toHaveProperty('type');
  });

  it('follows a packageManager the fork never touched and keeps one the fork changed', async () => {
    writePkg(upstreamPath, { name: 'backend', packageManager: 'pnpm@10.0.0' }, 'backend');
    commitPkg(upstreamPath, (pkg) => (pkg.packageManager = 'pnpm@10.0.0'), 'pin pnpm');
    exec('git pull --ff-only cella-upstream main', forkPath);
    commitPkg(forkPath, (pkg) => (pkg.packageManager = 'pnpm@10.5.0'), 'fork backend on a newer pnpm', 'backend');

    writePkg(upstreamPath, { name: 'backend', packageManager: 'pnpm@10.2.0' }, 'backend');
    commitPkg(upstreamPath, (pkg) => (pkg.packageManager = 'pnpm@10.2.0'), 'bump pnpm');
    fetchUpstream(forkPath);

    await runPackages(buildConfig({ packageJsonKeys: ['packageManager'] }));

    expect(readPkg(forkPath).packageManager).toBe('pnpm@10.2.0');
    expect(readPkg(forkPath, 'backend').packageManager).toBe('pnpm@10.5.0');
  });

  it('merges pnpm.overrides with add/bump-only logic', async () => {
    const forkOverrides = { 'esbuild@<=0.24.2': '>=0.25.0', 'fork-only-pkg@<1.0.0': '>=1.0.0' };
    commitPkg(forkPath, (pkg) => (pkg.pnpm = { overrides: forkOverrides }), 'add pnpm overrides');
    // Upstream bumps one override and adds one
    const upstreamOverrides = { 'esbuild@<=0.24.2': '>=0.26.0', 'hono@<4.12.7': '>=4.12.7' };
    commitPkg(upstreamPath, (pkg) => (pkg.pnpm = { overrides: upstreamOverrides }), 'add pnpm overrides');
    fetchUpstream(forkPath);

    await runPackages(buildConfig({ packageJsonKeys: ['dependencies', 'devDependencies', 'pnpm'] }));

    expect(readPkg(forkPath).pnpm).toEqual({
      overrides: { 'esbuild@<=0.24.2': '>=0.26.0', 'fork-only-pkg@<1.0.0': '>=1.0.0', 'hono@<4.12.7': '>=4.12.7' },
    });
  });

  it('merges pnpm.patchedDependencies and pnpm.packageExtensions add-only', async () => {
    const forkPnpm = {
      patchedDependencies: { 'slugify@1.6.6': 'patches/slugify@1.6.6.patch' },
      packageExtensions: { '@hookform/resolvers@5.2.2': { peerDependencies: { zod: '*' } } },
    };
    commitPkg(forkPath, (pkg) => (pkg.pnpm = forkPnpm), 'add fork patch and extension');
    const upstreamPnpm = {
      patchedDependencies: { 'dexie@4.3.0': 'patches/dexie@4.3.0.patch' },
      packageExtensions: { 'some-lib@1.0.0': { peerDependencies: { react: '*' } } },
    };
    commitPkg(upstreamPath, (pkg) => (pkg.pnpm = upstreamPnpm), 'add upstream patch and extension');
    fetchUpstream(forkPath);

    await runPackages(buildConfig({ packageJsonKeys: ['dependencies', 'devDependencies', 'pnpm'] }));

    expect(readPkg(forkPath).pnpm).toEqual({
      patchedDependencies: { ...forkPnpm.patchedDependencies, ...upstreamPnpm.patchedDependencies },
      packageExtensions: { ...forkPnpm.packageExtensions, ...upstreamPnpm.packageExtensions },
    });
  });

  it('fails on a fork package.json that does not parse, and leaves the file as it is', async () => {
    // A workspace upstream added since the base, where a fork without the package.json gets upstream's copy
    writePkg(upstreamPath, { name: 'oauth', dependencies: {} }, 'oauth');
    commitAll(upstreamPath, 'add oauth workspace');
    fetchUpstream(forkPath);
    write(forkPath, { 'oauth/package.json': '{ "name": ' });

    await expect(runPackages(buildConfig())).rejects.toThrow(/cannot parse .*oauth\/package\.json/);
    expect(fs.readFileSync(path.join(forkPath, 'oauth', 'package.json'), 'utf-8')).toBe('{ "name": ');
  });
});
