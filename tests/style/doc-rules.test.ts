import { beforeAll, describe, expect, it } from 'vitest';
import { commentFindings } from '../../src/tools/style/comment-rules';
import { docFindings } from '../../src/tools/style/doc-rules';
import { openRepository } from '../../src/tools/style/repo';
import { cliRoot } from '../helpers/style-repo';

const singular = ['invar', 'iant'].join('');
const dash = '\u2014';
const found = (file: string, source: string) =>
  docFindings(file, source).map(({ line, column, rule, term }) => ({ line, column, rule, term }));

beforeAll(() => openRepository(cliRoot));

describe('docFindings', () => {
  it('finds the concrete-language term in any case or plural, never inside longer words', () => {
    const source = [`# ${singular}`, `${singular}s`.toUpperCase(), `source-${singular}`, 'invariance, invariantly'];

    expect(found('guide.md', source.join('\n')).map(({ line, column, term }) => ({ line, column, term }))).toEqual([
      { line: 1, column: 3, term: singular },
      { line: 2, column: 1, term: `${singular}s`.toUpperCase() },
      { line: 3, column: 8, term: singular },
    ]);
  });

  it('reads prose only: inline code, fenced code and link targets are masked', () => {
    const source = [
      `Sync is lazy ${dash} rows arrive on demand.`,
      `Never write \`${dash}\` or \`load-bearing\`.`,
      '[reference](https://example.com/load-bearing)',
      '```text',
      `${singular} ${dash} load-bearing`,
      '```',
    ].join('\n');

    expect(found('guide.mdx', source)).toEqual([{ line: 1, column: 14, rule: 'em-dash', term: dash }]);
  });

  it('reads the agent wording rules in docs prose', () => {
    expect(found('guide.md', 'The result is load bearing and authoritative.').map(({ term }) => term)).toEqual([
      'load bearing',
      'authoritative',
    ]);
  });

  it('finds inline code in a link label, outside fenced code, double-backtick examples and image alt text', () => {
    const source = [
      'See [`define.ts`](./define.ts) and the [`align` skill][skills].',
      'Write [define.ts](./define.ts), never ``[`define.ts`](./define.ts)``. ![`logo`](./logo.svg)',
      '```md',
      '[`define.ts`](./define.ts)',
      '```',
    ].join('\n');

    expect(found('guide.md', source).map(({ line, column, term }) => ({ line, column, term }))).toEqual([
      { line: 1, column: 5, term: '[`define.ts`]' },
      { line: 1, column: 40, term: '[`align` skill]' },
    ]);
  });

  it('skips changelogs, non-doc files, and agent wording in alignments and infra', () => {
    expect(found('CHANGELOG.md', `${dash} ${singular}`)).toEqual([]);
    expect(found('guide.txt', `${dash} ${singular}`)).toEqual([]);
    expect(found('cella/alignments/x/README.md', 'This lands load-bearing code.')).toEqual([]);
    expect(found('infra/README.md', `A ${dash} here.`)).toHaveLength(1);
  });

  it('finds a prose paragraph over 80 words, hard-wrapped lines included, never a list, a table, code or an exempt folder', () => {
    const words = (count: number) => Array.from({ length: count }, (_, index) => `w${index}`).join(' ');
    const source = [
      '# T',
      '',
      words(81),
      '',
      `- ${words(81)}`,
      '',
      `| ${words(81)} |`,
      '',
      '```',
      words(81),
      '```',
      '',
      words(41),
      words(40),
    ];

    expect(found('guide.md', source.join('\n'))).toEqual([
      { line: 3, column: 1, rule: 'long-paragraph', term: '81 words' },
      { line: 13, column: 1, rule: 'long-paragraph', term: '81 words' },
    ]);
    expect(found('guide.md', `${words(79)} \`code counts nothing\` [label](target)`)).toEqual([]);
    expect(found('cella/skills/x/SKILL.md', words(81))).toEqual([]);
    expect(found('cella/alignments/x/README.md', words(81))).toEqual([]);
  });

  it('finds a ", so" tail outside "so that", and never in alignments or migration notes', () => {
    const long =
      'The row is cached in the browser for the whole session and shared by every open tab, so a reload is cheap.';
    expect(found('guide.md', `${long} Built so that it fits.`).map(({ rule }) => rule)).toEqual(['consequence-tail']);
    expect(found('cella/alignments/x/README.md', long)).toEqual([]);
    expect(found('cella/migrations/x/README.md', long)).toEqual([]);
  });

  it('lets a ", so" pair of at most 15 words pass, and reports a longer sentence, wrapped or not', () => {
    const short = 'It never fails, so a switch never blocks on it.';
    const long =
      'The frontend content security policy forbids eval in every mode, so the probe is a reported violation on every page load.';
    expect(found('guide.md', `${short} ${long}`).map(({ rule, column }) => ({ rule, column }))).toEqual([
      { rule: 'consequence-tail', column: short.length + 1 + long.indexOf(', so ') + 1 },
    ]);
    const tails = (findings: { line?: number; rule: string; term?: string }[]) =>
      findings.filter(({ rule }) => rule === 'consequence-tail').map(({ line, term }) => `${line}:${term}`);
    expect(tails(found('guide.md', long.replace('eval ', 'eval\n')))).toEqual(['2:, so ']);
    expect(tails(found('guide.md', long.replace(', so', ',\nso')))).toEqual(['1:, so ']);
    // The markers are no words: the 15-word pair on line 4 passes
    const jsdoc = [
      '/**',
      ` * ${long.replace(' so', '\n * so')}`,
      ` * ${short.replace('.', ', not even once more today.')}`,
      ' */',
      'export const probe = 1;',
    ].join('\n');
    expect(tails(commentFindings('src/probe.ts', jsdoc))).toEqual(['2:, so ']);
    const lineComments = `// ${long.replace(' so', '\n// so')}\nexport const probe = 1;`;
    expect(tails(commentFindings('src/probe.ts', lineComments))).toEqual(['1:, so ']);
  });
});
