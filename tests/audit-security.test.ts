/**
 * The security pass against a simulated pnpm: `install --lockfile-only` resolves a handful of
 * packages the way pnpm does (an override wins, then a locked version the parent's range admits,
 * then the parent's own pick), and `audit` reports what that leaves vulnerable.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { satisfiesComparators } from '../src/utils/versions';
import { readAuditSettings } from '../src/utils/workspace-yaml';

interface SimulatedPackage {
  /** What the parent's range admits. */
  admits: string;
  /** What the parent resolves to with nothing in the lockfile to prefer. */
  resolves: string;
  published: string[];
  advisory?: { ghsa: string; range: string };
}

const world = vi.hoisted(() => ({
  packages: {} as Record<string, SimulatedPackage>,
  auditAnswers: true,
  installStatus: 0,
  installs: [] as string[],
}));

const prompts = vi.hoisted(() => ({ confirm: vi.fn(), select: vi.fn() }));
vi.mock('@inquirer/prompts', () => prompts);

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: (_command: string, _args: string[], options: { cwd: string }) => {
    world.installs.push(options.cwd);
    return { status: world.installStatus };
  },
}));

const lockOf = (versions: Record<string, string>) =>
  `packages:\n${Object.entries(versions)
    .map(([name, version]) => `  ${name}@${version}:\n`)
    .join('')}`;

const lockedIn = (dir: string): Record<string, string> =>
  Object.fromEntries(
    [...readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').matchAll(/^ {2}(.+)@(\d[^:]*):$/gm)].map(
      ([, name, version]) => [name, version],
    ),
  );

vi.mock('../src/utils/audit-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/audit-utils')>()),
  runPnpmJson: async (_args: string[], cwd: string) => [{ path: cwd }],
  fetchPublishTimes: async (name: string) =>
    Object.fromEntries((world.packages[name]?.published ?? []).map((version) => [version, '2024-01-01T00:00:00Z'])),
  runPnpm: async (args: string[], cwd: string) => {
    if (args[0] !== 'install') return { ok: true, stdout: '1440', stderr: '' };
    const { overrides } = readAuditSettings(readFileSync(join(cwd, 'pnpm-workspace.yaml'), 'utf8'));
    const locked = lockedIn(cwd);
    const resolved = Object.fromEntries(
      Object.entries(world.packages).map(([name, pkg]) => {
        const override = Object.entries(overrides).find(([key]) => key.startsWith(`${name}@`))?.[1];
        const preferred = locked[name] && satisfiesComparators(locked[name], pkg.admits) ? locked[name] : pkg.resolves;
        return [name, override ? override.replace(/^\D+/, '') : preferred];
      }),
    );
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), lockOf(resolved));
    return { ok: true, stdout: '', stderr: '' };
  },
  runPnpmAudit: async (cwd: string) => {
    if (!world.auditAnswers) return null;
    const { ignoredGhsas } = readAuditSettings(readFileSync(join(cwd, 'pnpm-workspace.yaml'), 'utf8'));
    const advisories = Object.entries(lockedIn(cwd)).flatMap(([name, version]) => {
      const advisory = world.packages[name]?.advisory;
      if (!advisory || ignoredGhsas.includes(advisory.ghsa) || !satisfiesComparators(version, advisory.range))
        return [];
      return [
        {
          module_name: name,
          severity: 'high',
          vulnerable_versions: advisory.range,
          github_advisory_id: advisory.ghsa,
          findings: [{ version, paths: [`app>parent-of-${name}>${name}`] }],
        },
      ];
    });
    return { advisories: Object.fromEntries(advisories.map((advisory, i) => [String(i), advisory])) };
  },
}));

const { runSecurityPass } = await import('../src/services/audit-security');

/** An override that stopped being needed, one that still is, and an ignored advisory without a fix. */
const PACKAGES: Record<string, SimulatedPackage> = {
  stale: { admits: '>=1.0.0 <2.0.0', resolves: '1.0.1', published: ['1.0.0', '1.0.1'] },
  needed: {
    admits: '>=1.0.0 <2.0.0',
    resolves: '1.5.0',
    published: ['1.5.0', '2.0.0'],
    advisory: { ghsa: 'GHSA-needed', range: '<2.0.0' },
  },
  nofix: {
    admits: '>=3.0.0 <4.0.0',
    resolves: '3.0.3',
    published: ['3.0.3'],
    advisory: { ghsa: 'GHSA-nofix', range: '<=3.0.3' },
  },
};

const WORKSPACE = `auditConfig:
  ignoreGhsas:
    - GHSA-nofix
overrides:
  needed@<2.0.0: ^2.0.0
  stale@<1.0.1: ^1.0.1
`;

const LOCK = lockOf({ stale: '1.0.1', needed: '2.0.0', nofix: '3.0.3' });

const MANIFEST = '{"name":"app"}\n';
const DOCKERFILE = 'FROM caddy:2.8-alpine\n';

/** What the update step hands over: a manifest with a raised dependency, and a raised image tag. */
const EDITS = {
  manifests: { 'package.json': '{"name":"app","dependencies":{"stale":"^1.0.1"}}\n' },
  files: { Dockerfile: 'FROM caddy:2.11-alpine\n' },
};

describe('runSecurityPass', () => {
  let repo: string;
  const file = (name: string) => readFileSync(join(repo, name), 'utf8');

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cella-audit-test-'));
    writeFileSync(join(repo, 'package.json'), MANIFEST);
    writeFileSync(join(repo, 'Dockerfile'), DOCKERFILE);
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), WORKSPACE);
    writeFileSync(join(repo, 'pnpm-lock.yaml'), LOCK);
    Object.assign(world, { packages: structuredClone(PACKAGES), auditAnswers: true, installStatus: 0, installs: [] });
    prompts.confirm.mockReset();
    prompts.select.mockReset();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('drops the override the workspace no longer needs, keeps the rest, and writes the updates with the same install', async () => {
    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440, edits: EDITS });

    expect(file('pnpm-workspace.yaml')).toBe(WORKSPACE.replace('  stale@<1.0.1: ^1.0.1\n', ''));
    expect(file('pnpm-lock.yaml')).toBe(LOCK);
    expect(file('package.json')).toBe(EDITS.manifests['package.json']);
    expect(file('Dockerfile')).toBe(EDITS.files.Dockerfile);
    expect(world.installs).toEqual([repo]);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.select).not.toHaveBeenCalled();
  });

  it('writes nothing in report-only mode', async () => {
    await runSecurityPass(repo, { apply: false, releaseAgeMinutes: 1440 });

    expect(file('pnpm-workspace.yaml')).toBe(WORKSPACE);
    expect(file('pnpm-lock.yaml')).toBe(LOCK);
    expect(world.installs).toEqual([]);
  });

  it('changes nothing on a second run', async () => {
    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440 });
    const settled = file('pnpm-workspace.yaml');
    world.installs = [];

    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440 });

    expect(file('pnpm-workspace.yaml')).toBe(settled);
    expect(world.installs).toEqual([]);
  });

  it('puts every file back when the install fails', async () => {
    world.installStatus = 1;

    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440, edits: EDITS });

    expect(file('pnpm-workspace.yaml')).toBe(WORKSPACE);
    expect(file('pnpm-lock.yaml')).toBe(LOCK);
    expect(file('package.json')).toBe(MANIFEST);
    expect(file('Dockerfile')).toBe(DOCKERFILE);
  });

  it('leaves the workspace alone when the audit gives no answer', async () => {
    world.auditAnswers = false;

    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440 });

    expect(file('pnpm-workspace.yaml')).toBe(WORKSPACE);
    expect(world.installs).toEqual([]);
  });

  it('asks before a new breaking override, and leaves the advisory open on the default answer', async () => {
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), WORKSPACE.replace('  needed@<2.0.0: ^2.0.0\n', ''));
    prompts.select.mockResolvedValue('open');

    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440 });

    expect(prompts.select).toHaveBeenCalledOnce();
    expect(file('pnpm-workspace.yaml')).not.toContain('needed@');

    prompts.select.mockResolvedValue('override');
    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440 });

    expect(file('pnpm-workspace.yaml')).toContain('  needed@<2.0.0: ^2.0.0\n');
  });

  it('keeps the override a package had when its new, breaking fix is left open', async () => {
    world.packages.needed.published.push('3.0.0');
    world.packages.needed.advisory = { ghsa: 'GHSA-needed', range: '<3.0.0' };
    prompts.select.mockResolvedValue('open');

    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440 });

    expect(prompts.select).toHaveBeenCalledOnce();
    expect(file('pnpm-workspace.yaml')).toContain('  needed@<2.0.0: ^2.0.0\n');
    expect(file('pnpm-lock.yaml')).toBe(LOCK);
  });

  it('ignores a new advisory without a fix on request, with nothing to install', async () => {
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'overrides:\n  needed@<2.0.0: ^2.0.0\n');
    prompts.confirm.mockResolvedValue(true);

    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440 });

    expect(file('pnpm-workspace.yaml')).toBe(
      'auditConfig:\n  ignoreGhsas:\n    - GHSA-nofix\noverrides:\n  needed@<2.0.0: ^2.0.0\n',
    );
    expect(world.installs).toEqual([]);
  });

  it('writes nothing when a prompt is cancelled', async () => {
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'overrides:\n  stale@<1.0.1: ^1.0.1\n  needed@<2.0.0: ^2.0.0\n');
    prompts.confirm.mockRejectedValue(new Error('User force closed the prompt'));

    await runSecurityPass(repo, { apply: true, releaseAgeMinutes: 1440, edits: EDITS });

    expect(file('pnpm-workspace.yaml')).toContain('stale@<1.0.1');
    expect(file('package.json')).toBe(MANIFEST);
    expect(file('Dockerfile')).toBe(DOCKERFILE);
    expect(world.installs).toEqual([]);
  });
});
