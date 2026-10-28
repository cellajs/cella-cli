/**
 * Tests for `next steps`, the section analyze and upgrade end with: the numbered layout, and the
 * `align` step's wording for alignments arriving with an upgrade, arrived with one, or open.
 */
import fs from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config/types';
import { alignmentsStep } from '../src/services/align';
import { type NextStep, printNextSteps } from '../src/utils/display';
import { captureInfo, createRepo, exec, write } from './helpers/test-env';

const plain = (step: NextStep | undefined) =>
  step ? [step.line, ...(step.details ?? [])].map((line) => stripVTControlCharacters(line)) : undefined;

describe('printNextSteps', () => {
  it('numbers the steps under the section header, details lined up under each line', () => {
    const out = captureInfo(() =>
      printNextSteps([
        { label: 'review', line: 'file:///repo/.git/cella-diff/analyze-review.html', details: ['24 diffs'] },
        { label: 'upgrade', line: 'pnpm cella upgrade' },
      ]),
    );

    expect(stripVTControlCharacters(out).split('\n')).toEqual([
      '',
      'next steps',
      '─'.repeat(60),
      '',
      '  1 review   file:///repo/.git/cella-diff/analyze-review.html',
      '             24 diffs',
      '  2 upgrade  pnpm cella upgrade',
    ]);
  });

  it('prints nothing without steps', () => {
    expect(captureInfo(() => printNextSteps([]))).toBe('');
  });
});

describe('alignmentsStep', () => {
  let repo: string;
  const ids = Array.from({ length: 7 }, (_, i) => `2026010${i + 1}T0000-alignment-${i + 1}`);
  const config = () =>
    ({ forkPath: repo, settings: { upstreamUrl: 'git@github.com:cellajs/cella.git' } }) as RuntimeConfig;

  beforeAll(() => {
    repo = createRepo('cella-next-steps-');
    write(
      repo,
      Object.fromEntries(
        ids.map((id, i) => [
          `cella/alignments/${id}/README.md`,
          `---\nbreaking: ${i === 0}\nclientCacheBump: false\n${i === 0 ? 'caughtBy: compiler\n' : ''}---\n\n# Alignment ${i + 1}\n\nWhat changes.\n`,
        ]),
      ),
    );
    write(repo, { [`cella/alignments/${ids[0]}/codemod.ts`]: 'export {};\n' });
    exec('git add -A && git commit -q -m alignments', repo);
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('names the alignments arriving with a dry run, and runs align after the sync', async () => {
    expect(plain(await alignmentsStep(config(), { ref: 'HEAD', open: [ids[1]], arriving: [ids[0]] }))).toEqual([
      '1 alignment arrives with this upgrade · 1 open',
      '○ Alignment 1 · codemod · breaking · caught by compiler',
      `  id ${ids[0]}`,
      '○ Alignment 2 · manual · not breaking',
      `  id ${ids[1]}`,
      'after the upgrade: pnpm cella align',
    ]);
  });

  it('counts the ones a sync opened as open and says they arrived', async () => {
    const step = plain(await alignmentsStep(config(), { ref: 'HEAD', open: [ids[0], ids[1]], arrived: [ids[1]] }));

    expect(step?.[0]).toBe('2 alignments open · 1 arrived with this upgrade');
    expect(step?.at(-1)).toBe('pnpm cella align');
  });

  it('lists five, then counts the rest', async () => {
    const step = plain(await alignmentsStep(config(), { ref: 'HEAD', open: ids }));

    expect(step?.filter((line) => line.startsWith('○'))).toHaveLength(5);
    expect(step).toContain('+ 2 more');
  });

  it('falls back to the id for an alignment the ref does not hold', async () => {
    const step = plain(await alignmentsStep(config(), { ref: 'HEAD', open: ['20260201T0000-gone'] }));

    expect(step?.[1]).toBe('○ 20260201T0000-gone');
  });

  it('links each title to its README on GitHub', async () => {
    const step = await alignmentsStep(config(), { ref: 'HEAD', open: [ids[0]] });

    expect(step?.details?.[0]).toContain(
      `https://github.com/cellajs/cella/blob/HEAD/cella/alignments/${ids[0]}/README.md`,
    );
  });

  it('is left out when nothing arrives and nothing is open', async () => {
    expect(await alignmentsStep(config(), { ref: 'HEAD', open: [], arriving: [] })).toBeUndefined();
  });
});
