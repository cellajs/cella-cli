/**
 * Shared test scaffolding.
 *
 * Creates local git repos for testing against real git without network dependencies:
 * low-level helpers (exec, write, commitAll, createRepo) for single-repo unit tests, and
 * the isolated upstream + fork pair (createTestEnv) the sync e2e tests run against.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CellaCliConfig, RuntimeConfig, SyncService } from '../../src/config/types';

/** Git config for test commits */
export const GIT_USER = 'git config user.email "test@cellajs.com" && git config user.name "Cella Test"';

/** Upstream remote name used by sync CLI */
export const UPSTREAM_REMOTE = 'cella-upstream';

/**
 * Execute a shell command synchronously.
 */
export function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Write files into a repo (creating parent directories) without committing.
 */
export function write(repoPath: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/**
 * Stage everything and commit. Returns the commit sha.
 */
export function commitAll(repoPath: string, message: string): string {
  exec('git add -A', repoPath);
  exec(`git commit -m "${message}"`, repoPath);
  return exec('git rev-parse HEAD', repoPath);
}

/**
 * Create a temp git repo on `main` with the test identity.
 * With `files`, they are committed as the initial commit; without, the repo starts empty.
 */
export function createRepo(prefix: string, files?: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // -b main: don't depend on the runner's init.defaultBranch (CI defaults to master).
  exec('git init -b main', dir);
  exec(GIT_USER, dir);
  if (files) {
    write(dir, files);
    commitAll(dir, 'initial');
  }
  return dir;
}

/**
 * Test environment with upstream and fork repos.
 */
export interface TestEnv {
  /** Root temp directory for this test */
  testDir: string;
  /** Path to the upstream repo (simulates cellajs/cella) */
  upstreamPath: string;
  /** Path to the fork repo (simulates user's app) */
  forkPath: string;
  /** Clean up the test environment */
  cleanup: () => void;
}

/**
 * Create a fresh test environment with upstream and fork repos.
 *
 * Both repos start with the same initial commit, then can be modified
 * independently to create various sync scenarios. `files` replaces the
 * default initial upstream content.
 */
export function createTestEnv(options: { files?: Record<string, string> } = {}): TestEnv {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-e2e-'));
  const upstreamPath = path.join(testDir, 'upstream');
  const forkPath = path.join(testDir, 'fork');

  // Create upstream repo with initial content
  fs.mkdirSync(upstreamPath);
  // -b main: don't depend on the runner's init.defaultBranch (CI defaults to master).
  exec('git init -b main', upstreamPath);
  exec(GIT_USER, upstreamPath);

  write(
    upstreamPath,
    options.files ?? {
      'backend/src/index.ts': '// Backend entry\nexport const backend = true;\n',
      'frontend/src/index.ts': '// Frontend entry\nexport const frontend = true;\n',
      'README.md': '# Test Repo\n',
      'package.json': '{"name": "test-upstream"}\n',
    },
  );
  commitAll(upstreamPath, 'Initial commit');

  // Clone to create fork (same starting point)
  exec(`git clone ${upstreamPath} ${forkPath}`);
  exec(GIT_USER, forkPath);

  // Rename origin to cella-upstream in fork (simulating sync setup)
  exec(`git remote rename origin ${UPSTREAM_REMOTE}`, forkPath);

  return {
    testDir,
    upstreamPath,
    forkPath,
    cleanup: () => {
      fs.rmSync(testDir, { recursive: true, force: true });
    },
  };
}

/**
 * Make a commit in a repo with the given files.
 */
export function makeCommit(
  repoPath: string,
  options: {
    files: Record<string, string>;
    message: string;
  },
): string {
  write(repoPath, options.files);
  return commitAll(repoPath, options.message);
}

/**
 * Delete a file and commit.
 */
export function deleteFileAndCommit(repoPath: string, filePath: string, message: string): string {
  const fullPath = path.join(repoPath, filePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
  exec('git add -A', repoPath);
  exec(`git commit -m "${message}"`, repoPath);
  return exec('git rev-parse HEAD', repoPath);
}

/**
 * Rename/move a file and commit.
 * Uses git mv to ensure git detects it as a rename.
 */
export function renameFileAndCommit(repoPath: string, oldPath: string, newPath: string, message: string): string {
  const newDir = path.dirname(path.join(repoPath, newPath));
  if (!fs.existsSync(newDir)) {
    fs.mkdirSync(newDir, { recursive: true });
  }
  exec(`git mv "${oldPath}" "${newPath}"`, repoPath);
  exec(`git commit -m "${message}"`, repoPath);
  return exec('git rev-parse HEAD', repoPath);
}

/**
 * Read a file from a repo. Returns null if file doesn't exist.
 */
export function readRepoFile(repoPath: string, filePath: string): string | null {
  const fullPath = path.join(repoPath, filePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

/**
 * Check if a file exists in a repo.
 */
export function fileExists(repoPath: string, filePath: string): boolean {
  return fs.existsSync(path.join(repoPath, filePath));
}

/**
 * Fetch upstream changes into fork.
 */
export function fetchUpstream(forkPath: string): void {
  exec(`git fetch ${UPSTREAM_REMOTE}`, forkPath);
}

/**
 * Create an annotated tag at the current HEAD of a repo (simulates a release).
 */
export function tagUpstream(repoPath: string, tag: string): void {
  exec(`git tag -a ${tag} -m "release ${tag}"`, repoPath);
}

/**
 * Build a RuntimeConfig for testing without going through CLI.
 */
export function buildRuntimeConfig(
  env: TestEnv,
  options: {
    service?: SyncService;
    pinned?: string[];
    ignored?: string[];
    track?: 'release' | 'branch';
    trackOverride?: 'release' | 'branch';
    /** A pinned upstream ref (`--ref`) */
    ref?: string;
    /** Merge with the fork config as it stands (`--keep-config`) */
    keepConfig?: boolean;
  } = {},
): RuntimeConfig {
  const { service = 'analyze', pinned = [], ignored = [], track = 'branch', trackOverride, ref, keepConfig } = options;

  const config: CellaCliConfig = {
    settings: {
      upstreamUrl: env.upstreamPath,
      upstreamBranch: 'main',
      upstreamTrack: track,
    },
    overrides: {
      pinned,
      ignored,
    },
  };

  return {
    ...config,
    forkPath: env.forkPath,
    upstreamRef: `${UPSTREAM_REMOTE}/main`,
    service,
    track: trackOverride,
    ref,
    keepConfig,
    logFile: false,
    list: false,
    json: false,
    verbose: false,
  };
}

/**
 * Reset fork to a clean state (abort any in-progress merge).
 */
export function resetFork(forkPath: string): void {
  try {
    exec('git merge --abort', forkPath);
  } catch {
    // Ignore if no merge in progress
  }
  exec('git checkout .', forkPath);
  exec('git clean -fd', forkPath);
}
