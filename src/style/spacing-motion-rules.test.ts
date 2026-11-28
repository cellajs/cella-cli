import { describe, expect, it } from 'vitest';
import { check } from '../../tests/helpers/style-repo';
import type { Rule } from './rule';
import { childSpacingRule, motionTimingRule } from './spacing-motion-rules';

const file = 'frontend/src/modules/example/example.tsx';
const terms = (rule: Rule, source: string, path = file) => check([rule], path, source).map(({ term }) => term);

describe('child-spacing', () => {
  const cases: [token: string, flagged: boolean][] = [
    ['space-y-2', true],
    ['sm:space-y-2', true],
    ['-space-x-1', true],
    ['space-x-reverse', true],
    ['divide-y', true],
    ['md:divide-x-2', true],
    ['gap-2', false],
    ['whitespace-nowrap', false],
    ['divide-border', false],
    ['divide-dashed', false],
  ];

  it.each(cases)('%s flagged: %s', (token, flagged) => {
    expect(terms(childSpacingRule, `const a = <div className="${token} flex">x</div>;`)).toEqual(flagged ? [token] : []);
  });
});

describe('motion-timing', () => {
  const cases: [path: string, source: string, found: string[]][] = [
    [file, "const a = cn('animate-in fade-in', open && 'data-closed:animate-out');", ['animate-in', 'data-closed:animate-out']],
    [file, "const a = cn('animate-spin transition-opacity', 'animate-pulse');", []],
    [file, "const ease = 'ease-[cubic-bezier(0.2,0,0,1)]';", ['cubic-bezier(']],
    ['frontend/src/modules/example/example.css', '.panel { transition: opacity 200ms cubic-bezier(0.2, 0, 0, 1); }', ['cubic-bezier(']],
    ['frontend/src/styling/tailwind.css', '@theme { --ease-out-soft: cubic-bezier(0.2, 0, 0, 1); }', []],
  ];

  it.each(cases)('%s: %s', (path, source, found) => {
    expect(terms(motionTimingRule, source, path)).toEqual(found);
  });
});
