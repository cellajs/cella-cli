/**
 * Tests for the CLI version check.
 *
 * A sync bumps the fork's CLI with its other packages, so without the check each sync runs on the
 * previous CLI. `readUpstreamCliRange` reads the range from upstream's root package.json at a ref,
 * and `cliVersionMismatch` blocks only when the running CLI is below the range's lower bound.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliVersionMismatch, readUpstreamCliRange } from '../src/utils/cli-version';
import { createRepo, exec } from './helpers/test-env';

describe('cliVersionMismatch', () => {
  it('blocks a CLI below the lower bound and names the range to install', () => {
    const message = cliVersionMismatch('0.2.2', '^0.2.3');
    expect(message).toContain('@cellajs/cli ^0.2.3, this is 0.2.2');
    expect(message).toContain(`pnpm add -D -w '@cellajs/cli@^0.2.3'`);
    expect(cliVersionMismatch('0.2.9', '>=0.3.0')).not.toBeNull();
    expect(cliVersionMismatch('0.2.3', '0.2.4')).not.toBeNull();
  });

  it('lets an equal or newer CLI run', () => {
    expect(cliVersionMismatch('0.2.3', '^0.2.3')).toBeNull();
    expect(cliVersionMismatch('0.3.0', '^0.2.3')).toBeNull();
    expect(cliVersionMismatch('1.0.0-beta.1', '~0.9.0')).toBeNull();
  });

  it('never blocks on a range without a lower bound', () => {
    for (const range of [
      'workspace:*',
      'link:../cella-cli',
      'file:../cella-cli',
      '*',
      '<0.3.0',
      '>0.2.3',
      '^0.2.3 || ^0.3.0',
    ]) {
      expect(cliVersionMismatch('0.1.0', range)).toBeNull();
    }
  });
});

describe('readUpstreamCliRange', () => {
  let repoPath: string;

  /** Commit a root package.json (raw source) and return the commit sha. */
  function commitPackageJson(source: string): string {
    fs.writeFileSync(path.join(repoPath, 'package.json'), source);
    exec('git add -A && git commit -q -m step', repoPath);
    return exec('git rev-parse HEAD', repoPath);
  }

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('reads the range at the given ref, from devDependencies or dependencies', async () => {
    repoPath = createRepo('cella-cli-version-');
    const older = commitPackageJson(JSON.stringify({ devDependencies: { '@cellajs/cli': '^0.2.2' } }));
    const newer = commitPackageJson(JSON.stringify({ dependencies: { '@cellajs/cli': '^0.2.3' } }));

    expect(await readUpstreamCliRange(repoPath, older)).toBe('^0.2.2');
    expect(await readUpstreamCliRange(repoPath, newer)).toBe('^0.2.3');
  });

  it('returns null when upstream names no CLI, has no package.json or an unparsable one', async () => {
    repoPath = createRepo('cella-cli-version-');
    const none = commitPackageJson(JSON.stringify({ devDependencies: { typescript: '^6.0.0' } }));
    const broken = commitPackageJson('{ not json');

    expect(await readUpstreamCliRange(repoPath, none)).toBeNull();
    expect(await readUpstreamCliRange(repoPath, broken)).toBeNull();
    expect(await readUpstreamCliRange(repoPath, `${none}~1`)).toBeNull();
  });
});
