/**
 * E2E tests for scaffold-base inference in ensureSyncBase.
 *
 * A create-cella scaffold has a rootless initial commit with no shared history with
 * upstream and no recorded provenance. ensureSyncBase must infer the upstream commit the
 * scaffold snapshot was taken from by tree similarity, graft ancestry onto it, and record
 * it as refs/cella/last-sync — or fail with the manual-seed error when the fork's root
 * does not resemble upstream at all.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSyncBase } from '../../src/utils/git';

const UPSTREAM_REMOTE = 'cella-upstream';
const GIT_USER = 'git config user.email "test@cellajs.com" && git config user.name "Cella Test"';

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(repoPath: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function commitAll(repoPath: string, message: string): string {
  exec('git add -A', repoPath);
  exec(`git commit -m "${message}"`, repoPath);
  return exec('git rev-parse HEAD', repoPath);
}

/** Enough files that scaffold edits stay well under the inference confidence threshold. */
function templateFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': '{"name": "cella", "version": "1.0.0"}\n',
    'README.md': '# Cella\n',
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n- everything\n',
  };
  for (let i = 0; i < 20; i++) {
    files[`backend/src/module-${i}.ts`] = `export const module${i} = ${i};\n`;
  }
  files['frontend/src/optional/widget.ts'] = 'export const widget = true;\n';
  files['frontend/src/optional/helper.ts'] = 'export const helper = true;\n';
  return files;
}

/**
 * Simulate `create-cella`: snapshot the upstream tree at `ref` into a fresh repo with a
 * rootless initial commit, applying template-cleaner-style edits (rewrite project files,
 * drop a deselected module folder, add a generated config). When `trailerSha` is given,
 * stamp it as the `Cella-Base:` provenance trailer like create-cella does.
 */
function scaffoldFork(upstreamPath: string, ref: string, forkPath: string, trailerSha?: string): void {
  fs.mkdirSync(forkPath, { recursive: true });
  exec(`git archive ${ref} | tar -x -C "${forkPath}"`, upstreamPath);

  write(forkPath, {
    'package.json': '{"name": "my-app", "version": "0.0.0"}\n',
    'README.md': '# My App\n',
    'CHANGELOG.md': '# Changelog\n',
    'config.generated.ts': 'export const port = 4000;\n',
  });
  fs.rmSync(path.join(forkPath, 'frontend/src/optional'), { recursive: true, force: true });

  exec('git init -b main', forkPath);
  exec(GIT_USER, forkPath);
  exec('git add -A', forkPath);
  const trailer = trailerSha ? ` -m "Cella-Base: ${trailerSha}"` : '';
  exec(`git commit -m "Initial commit"${trailer}`, forkPath);

  exec(`git remote add ${UPSTREAM_REMOTE} "${upstreamPath}"`, forkPath);
  exec(`git fetch ${UPSTREAM_REMOTE}`, forkPath);
}

describe('ensureSyncBase scaffold inference', () => {
  let testDir: string;
  let upstreamPath: string;
  let forkPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-base-'));
    upstreamPath = path.join(testDir, 'upstream');
    forkPath = path.join(testDir, 'fork');

    fs.mkdirSync(upstreamPath);
    exec('git init -b main', upstreamPath);
    exec(GIT_USER, upstreamPath);
    write(upstreamPath, templateFiles());
    commitAll(upstreamPath, 'Initial commit');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('infers the scaffold base by tree similarity and grafts ancestry onto it', async () => {
    // Upstream evolves: the scaffold is taken at `base`, then upstream moves on.
    write(upstreamPath, { 'backend/src/module-0.ts': 'export const module0 = "changed";\n' });
    const base = commitAll(upstreamPath, 'change module-0');

    scaffoldFork(upstreamPath, base, forkPath);

    // Upstream commits after the scaffold — inference must not pick these.
    write(upstreamPath, { 'backend/src/module-1.ts': 'export const module1 = "newer";\n' });
    commitAll(upstreamPath, 'change module-1');
    write(upstreamPath, { 'backend/src/module-2.ts': 'export const module2 = "newest";\n' });
    commitAll(upstreamPath, 'change module-2');
    exec(`git fetch ${UPSTREAM_REMOTE}`, forkPath);

    // Fork-local work after scaffolding must not affect inference (it scores the root commit).
    write(forkPath, { 'frontend/src/app.ts': 'export const app = true;\n' });
    commitAll(forkPath, 'local work');

    await ensureSyncBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`);

    expect(exec('git rev-parse refs/cella/last-sync', forkPath)).toBe(base);
    expect(exec(`git merge-base HEAD ${UPSTREAM_REMOTE}/main`, forkPath)).toBe(base);
  });

  it('resolves ties toward the newest candidate when commits only touch scaffold-rewritten files', async () => {
    // Scaffold from `older`; a release-style commit `newer` touches only files the
    // template cleaner rewrites, so both candidates score identically — newest wins,
    // and either is a correct 3-way merge base.
    const older = exec('git rev-parse HEAD', upstreamPath);
    scaffoldFork(upstreamPath, older, forkPath);

    write(upstreamPath, {
      'package.json': '{"name": "cella", "version": "1.1.0"}\n',
      'CHANGELOG.md': '# Changelog\n\n## 1.1.0\n- release\n',
    });
    const newer = commitAll(upstreamPath, 'chore: release 1.1.0');
    exec(`git fetch ${UPSTREAM_REMOTE}`, forkPath);

    await ensureSyncBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`);

    expect(exec('git rev-parse refs/cella/last-sync', forkPath)).toBe(newer);
  });

  it('prefers the Cella-Base trailer over tree inference', async () => {
    // Trailer points at the initial upstream commit while the snapshot tree matches a
    // newer commit — the exact recorded provenance must win over similarity guessing.
    const recorded = exec('git rev-parse HEAD', upstreamPath);
    write(upstreamPath, { 'backend/src/module-0.ts': 'export const module0 = "changed";\n' });
    const newer = commitAll(upstreamPath, 'change module-0');

    scaffoldFork(upstreamPath, newer, forkPath, recorded);

    await ensureSyncBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`);

    expect(exec('git rev-parse refs/cella/last-sync', forkPath)).toBe(recorded);
  });

  it('falls through to inference when the trailer SHA is not a known commit', async () => {
    // A stale trailer (upstream squashed its history, or the fork points at a different
    // upstream) must not hard-fail — the reseed fallback infers the base instead.
    const base = exec('git rev-parse HEAD', upstreamPath);
    scaffoldFork(upstreamPath, base, forkPath, 'a'.repeat(40));

    await ensureSyncBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`);

    expect(exec('git rev-parse refs/cella/last-sync', forkPath)).toBe(base);
  });

  it('rejects a fork whose root does not resemble any upstream snapshot', async () => {
    fs.mkdirSync(forkPath);
    exec('git init -b main', forkPath);
    exec(GIT_USER, forkPath);
    write(forkPath, {
      'index.js': 'console.log("hand-rolled");\n',
      'lib/util.js': 'module.exports = {};\n',
    });
    commitAll(forkPath, 'Initial commit');
    exec(`git remote add ${UPSTREAM_REMOTE} "${upstreamPath}"`, forkPath);
    exec(`git fetch ${UPSTREAM_REMOTE}`, forkPath);

    await expect(ensureSyncBase(forkPath, 'HEAD', `${UPSTREAM_REMOTE}/main`)).rejects.toThrow(
      /no sync base could be determined/,
    );
  });
});
