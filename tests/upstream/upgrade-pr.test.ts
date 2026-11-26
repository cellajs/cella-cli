/**
 * Unit tests for the upgrade PR content builders.
 *
 * Covers buildUpgradePrBody (pure markdown rendering, including upstream PR-ref qualification and
 * truncation) and the git readers that recover the upgrade range from committed manifests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildUpgradePrBody,
  type GhPullRequest,
  ownUpgradePrs,
  readPackageVersionAtRef,
} from '../../src/upstream/pull-requests';
import { readManifestAtRef, readUpgradePointAtRef } from '../../src/upstream/upgrade-point';
import { createManifestRepo, exec } from '../helpers/test-env';

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);

describe('buildUpgradePrBody', () => {
  it('renders header, compare link and linked commit list', () => {
    const body = buildUpgradePrBody({
      repoSlug: 'cellajs/cella',
      version: '0.2.2',
      fromSha: shaA,
      toSha: shaB,
      totalCount: 2,
      commits: [
        { hash: shaA, message: 'fix: type in yjs Dockerfile (#843)', date: '2 days ago' },
        { hash: shaB, message: 'feat: log refactor (#848)', date: 'yesterday' },
      ],
    });

    expect(body).toContain('Upgrades [cellajs/cella](https://github.com/cellajs/cella)');
    expect(body).toContain(`[\`${'b'.repeat(7)}\`](https://github.com/cellajs/cella/commit/${shaB}) (v0.2.2).`);
    expect(body).toContain('**2 upstream commits since the last upgrade**');
    expect(body).toContain(`[compare](https://github.com/cellajs/cella/compare/${'a'.repeat(7)}...${'b'.repeat(7)})`);
    // A reader would take bare #843 for the app's own PR: it must be qualified with the upstream slug.
    expect(body).toContain('`fix: type in yjs Dockerfile (cellajs/cella#843)`');
    expect(body).not.toContain('(#843)');
  });

  it('normalizes a v-prefixed release tag', () => {
    const body = buildUpgradePrBody({
      repoSlug: 'cellajs/cella',
      version: 'v1.2.3',
      toSha: shaB,
      totalCount: 0,
      commits: [],
    });
    expect(body).toContain('(v1.2.3).');
    expect(body).not.toContain('vv1.2.3');
  });

  it('notes earlier commits when the list is truncated', () => {
    const body = buildUpgradePrBody({
      repoSlug: 'cellajs/cella',
      version: null,
      fromSha: shaA,
      toSha: shaB,
      totalCount: 60,
      commits: [{ hash: shaB, message: 'feat: latest', date: 'today' }],
    });
    expect(body).toContain('**60 upstream commits since the last upgrade**');
    expect(body).toContain('- …59 earlier commit(s) not shown');
  });

  it('omits the commit section when the range is unknown', () => {
    const body = buildUpgradePrBody({
      repoSlug: 'cellajs/cella',
      version: '0.2.2',
      fromSha: null,
      toSha: shaB,
      totalCount: 0,
      commits: [],
    });
    expect(body).toContain('Upgrades');
    expect(body).not.toContain('since the last upgrade');
  });

  it('degrades to plain text without a repo slug', () => {
    const body = buildUpgradePrBody({
      version: null,
      fromSha: shaA,
      toSha: shaB,
      totalCount: 1,
      commits: [{ hash: shaA, message: 'fix: thing (#12)', date: 'today' }],
    });
    expect(body).toContain('Upgrades cella to `bbbbbbb`.');
    expect(body).toContain('- `aaaaaaa` `fix: thing (#12)`');
    expect(body).not.toContain('https://github.com');
  });

  it('keeps an upstream subject from mentioning, closing or hiding anything in the app', () => {
    const body = buildUpgradePrBody({
      version: '1.0.0 <!--',
      fromSha: shaA,
      toSha: shaB,
      totalCount: 1,
      commits: [{ hash: shaA, message: 'fix: `x` closes #1, cc @octocat <!--', date: 'today' }],
    });
    expect(body).toBe(
      'Upgrades cella to `bbbbbbb`.\n\n**1 upstream commit since the last upgrade**:\n\n' +
        '- `aaaaaaa` `` fix: `x` closes #1, cc @octocat <!-- ``\n',
    );
  });
});

describe('ownUpgradePrs', () => {
  it('never offers a pull request from another repository, whatever its branch is named', () => {
    const pr = (number: number, isCrossRepository: boolean): GhPullRequest => ({
      number,
      title: 'chore: upgrade',
      headRefName: 'cella/upgrade/x',
      url: `https://github.com/acme/app/pull/${number}`,
      isCrossRepository,
      author: { login: isCrossRepository ? 'stranger' : 'developer' },
    });
    expect(ownUpgradePrs([pr(2, true), pr(1, false)], 'cella/upgrade').map((p) => p.number)).toEqual([1]);
  });
});

describe('manifest and version readers', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createManifestRepo();
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('reads the manifest committed at a ref, not the working tree', async () => {
    const committed = { upstream: { repo: 'cellajs/cella', commit: shaA, release: null } };
    fs.writeFileSync(path.join(repoPath, 'cella', 'cella.manifest.json'), JSON.stringify(committed));
    exec('git add -A && git commit -m "chore: manifest"', repoPath);

    // Worktree moves ahead (staged upgrade): the committed manifest must still win.
    fs.writeFileSync(
      path.join(repoPath, 'cella', 'cella.manifest.json'),
      JSON.stringify({ upstream: { commit: shaB } }),
    );

    const manifest = await readManifestAtRef(repoPath, 'HEAD');
    expect(manifest?.upstream.repo).toBe('cellajs/cella');
    expect(await readUpgradePointAtRef(repoPath, 'HEAD')).toBe(shaA);
  });

  it('returns null for a missing or malformed manifest', async () => {
    expect(await readManifestAtRef(repoPath, 'HEAD')).toBeNull();

    fs.writeFileSync(path.join(repoPath, 'cella', 'cella.manifest.json'), '{"upstream":{"commit":"nope"}}');
    exec('git add -A && git commit -m "chore: bad manifest"', repoPath);
    expect(await readManifestAtRef(repoPath, 'HEAD')).toBeNull();
    expect(await readUpgradePointAtRef(repoPath, 'HEAD')).toBeNull();
  });

  it('reads the package.json version at a ref', async () => {
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'cella', version: '0.2.2' }));
    exec('git add -A && git commit -m "chore: package"', repoPath);
    expect(await readPackageVersionAtRef(repoPath, 'HEAD')).toBe('0.2.2');
    expect(await readPackageVersionAtRef(repoPath, 'HEAD~1')).toBeNull();

    fs.writeFileSync(path.join(repoPath, 'package.json'), '{not json');
    exec('git add -A && git commit -m "chore: break package"', repoPath);
    expect(await readPackageVersionAtRef(repoPath, 'HEAD')).toBeNull();
  });
});
