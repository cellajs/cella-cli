/**
 * Shared test scaffolding.
 *
 * Creates local git repos for testing against real git without network dependencies:
 * low-level helpers (exec, write, commitAll, createRepo) for single-repo unit tests, and
 * the isolated upstream + app pair (createTestEnv) the upgrade e2e tests run against.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { CellaCliConfig, RuntimeConfig } from '../../src/config/types';
import type { AnalyzedFile, FileStatus } from '../../src/upstream/model';

/** Git config for test commits */
export const gitUser = 'git config user.email "test@cellajs.com" && git config user.name "Cella Test"';

/** Upstream remote name used by upgrade CLI */
export const upstreamRemote = 'cella-upstream';

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
 * Create a git repo on `main` with the test identity: at `target` when it is an absolute path, else
 * in a fresh temp dir named with `target` as prefix. With `files`, they are committed as the
 * initial commit; without, the repo starts empty.
 */
export function createRepo(target: string, files?: Record<string, string>): string {
  const dir = path.isAbsolute(target) ? target : fs.mkdtempSync(path.join(os.tmpdir(), target));
  fs.mkdirSync(dir, { recursive: true });
  // -b main: don't depend on the runner's init.defaultBranch (CI defaults to master).
  exec('git init -b main', dir);
  exec(gitUser, dir);
  if (files) {
    write(dir, files);
    commitAll(dir, 'initial');
  }
  return dir;
}

/** A temp repo with an initial commit and the `cella/` dir the upgrade manifest lives in. */
export function createManifestRepo(): string {
  const dir = createRepo('cella-git-test-', { 'initial.txt': 'initial\n' });
  fs.mkdirSync(path.join(dir, 'cella'));
  return dir;
}

/**
 * Test environment with upstream and app repos.
 */
export interface TestEnv {
  /** Root temp directory for this test */
  testDir: string;
  /** Path to the upstream repo (simulates cellajs/cella) */
  upstreamPath: string;
  /** Path to the app repo (simulates user's app) */
  repoRoot: string;
  /** Clean up the test environment */
  cleanup: () => void;
}

/**
 * Create a fresh test environment with upstream and app repos.
 *
 * Both repos start with the same initial commit, then can be modified
 * independently to create various upgrade scenarios. `files` replaces the
 * default initial upstream content.
 */
export function createTestEnv(options: { files?: Record<string, string> } = {}): TestEnv {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-e2e-'));
  const upstreamPath = path.join(testDir, 'upstream');
  const repoRoot = path.join(testDir, 'app');

  createRepo(
    upstreamPath,
    options.files ?? {
      'backend/src/index.ts': '// Backend entry\nexport const backend = true;\n',
      'frontend/src/index.ts': '// Frontend entry\nexport const frontend = true;\n',
      'README.md': '# Test Repo\n',
      'package.json': '{"name": "test-upstream"}\n',
    },
  );

  // Clone to create app (same starting point)
  exec(`git clone ${upstreamPath} ${repoRoot}`);
  exec(gitUser, repoRoot);

  // Rename origin to cella-upstream in app (simulating upgrade setup)
  exec(`git remote rename origin ${upstreamRemote}`, repoRoot);

  return {
    testDir,
    upstreamPath,
    repoRoot,
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
  fs.rmSync(path.join(repoPath, filePath), { force: true });
  return commitAll(repoPath, message);
}

/**
 * Rename/move a file and commit.
 * Uses git mv to ensure git detects it as a rename.
 */
export function renameFileAndCommit(repoPath: string, oldPath: string, newPath: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(repoPath, newPath)), { recursive: true });
  exec(`git mv "${oldPath}" "${newPath}"`, repoPath);
  return commitAll(repoPath, message);
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
 * Fetch upstream changes into app.
 */
export function fetchUpstream(repoRoot: string): void {
  exec(`git fetch ${upstreamRemote}`, repoRoot);
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
    pinned?: string[];
    ignored?: string[];
    track?: 'release' | 'branch';
    trackOverride?: 'release' | 'branch';
    /** A pinned upstream ref (`--ref`) */
    ref?: string;
    /** Merge with the app config as it stands (`--keep-config`) */
    keepConfig?: boolean;
    /** Lift every pinned entry for this run (`--unpinned`) */
    unpinned?: boolean;
  } = {},
): RuntimeConfig {
  const { pinned = [], ignored = [], track = 'branch', trackOverride, ref, keepConfig } = options;
  const { unpinned } = options;

  const config: CellaCliConfig = {
    upstreamUrl: env.upstreamPath,
    upstreamBranch: 'main',
    upstreamTrack: track,
    pinned,
    ignored,
  };

  return {
    ...config,
    repoRoot: env.repoRoot,
    upstreamRef: `${upstreamRemote}/main`,
    track: trackOverride,
    ref,
    keepConfig,
    unpinned,
  };
}

/**
 * Reset app to a clean state (abort any in-progress merge).
 */
export function resetApp(repoRoot: string): void {
  try {
    exec('git merge --abort', repoRoot);
  } catch {
    // Ignore if no merge in progress
  }
  exec('git checkout .', repoRoot);
  exec('git clean -fd', repoRoot);
}

/** Run `print` with `console.info` captured, and return the printed lines. */
export function captureInfo(print: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    print();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

/** An analyzed file, unprotected and present on both sides unless `overrides` say otherwise. */
export function analyzedFile(overrides: Partial<AnalyzedFile> & { path: string; status: FileStatus }): AnalyzedFile {
  return { isIgnored: false, isPinned: false, existsInApp: true, existsInUpstream: true, ...overrides };
}
