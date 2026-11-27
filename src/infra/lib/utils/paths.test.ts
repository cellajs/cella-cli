import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appRootOf } from './paths';

const base = mkdtempSync(join(tmpdir(), 'app-root-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const description = { 'infra/description.yml': '' };
const workspace = { 'infra/package.json': '{ "name": "infra" }' };

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
    ["the infra workspace's parent, where its scripts run", { ...description, ...workspace }, 'infra', '.'],
    // A pull request that adds one would move the root of every script the infra workspace runs
    [
      'refuses a description nested in infra/infra/',
      { ...description, ...workspace, 'infra/infra/description.yml': '' },
      'infra',
      /infra\/infra\/description\.yml: /,
    ],
    ['refuses a root without a description', workspace, 'infra', /alignment infra-description/],
    // A worktree inside an app reads no description, env or stack file of the checkout around it
    [
      'refuses a worktree without a description of its own',
      { ...description, '.claude/worktrees/x/package.json': '{}' },
      '.claude/worktrees/x',
      /has no infra/,
    ],
  ];

  it.each(cases)('%s', (_found, files, from, expected) => {
    const root = app(files);
    if (typeof expected === 'string') expect(appRootOf(join(root, from))).toBe(join(root, expected));
    else expect(() => appRootOf(join(root, from))).toThrow(expected);
  });
});
