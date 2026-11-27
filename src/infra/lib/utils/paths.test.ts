import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appRootOf } from './paths';

const base = mkdtempSync(join(tmpdir(), 'app-root-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const description = { 'cella/infra/description.yml': '' };

/** A new app folder holding `files`, each at its path from the folder. */
function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(base, 'app-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('the app root', () => {
  const cases: [found: string, files: Record<string, string>, from: string, expected: string | RegExp][] = [
    ['the working directory', description, '.', '.'],
    // Pulumi runs the program in the folder that holds Pulumi.yaml
    ['two up from the cella/infra folder', description, 'cella/infra', '.'],
    // A pull request that adds one would move the root of every task that runs in cella/infra
    [
      'refuses a description nested in cella/infra/cella/infra/',
      { ...description, 'cella/infra/cella/infra/description.yml': '' },
      'cella/infra',
      /cella\/infra\/cella\/infra\/description\.yml: /,
    ],
    ['refuses a root without a description', { 'package.json': '{}' }, '.', /has no cella\/infra\/description\.yml.*alignment infra-description/],
    // An upgrade that brings the engine before the alignment runs reads nothing of the old layout
    [
      'refuses a root that keeps its infra in infra/',
      { 'infra/package.json': '{ "name": "infra" }', 'infra/description.yml': '' },
      '.',
      /keeps its infra in infra\/.*alignment infra-description/,
    ],
    // A worktree inside an app reads no description, env or stack file of the checkout around it
    [
      'refuses a worktree without a description of its own',
      { ...description, '.claude/worktrees/x/package.json': '{}' },
      '.claude/worktrees/x',
      /has no cella\/infra/,
    ],
  ];

  it.each(cases)('%s', (_found, files, from, expected) => {
    const root = app(files);
    if (typeof expected === 'string') expect(appRootOf(join(root, from))).toBe(join(root, expected));
    else expect(() => appRootOf(join(root, from))).toThrow(expected);
  });
});
