import { describe, expect, it } from 'vitest';
import { applyDelta } from '../src/tools/adapters';

describe('applyDelta', () => {
  it("drops the app's removed ids, replaces an added id in place and appends the rest", () => {
    const base = [
      { id: 'a', from: 'base' },
      { id: 'b', from: 'base' },
      { id: 'c', from: 'base' },
    ];
    const add = [
      { id: 'c', from: 'app' },
      { id: 'd', from: 'app' },
    ];

    expect(applyDelta(base, { remove: ['a'], add }, 'cella/a11y.app.ts')).toEqual([
      { id: 'b', from: 'base' },
      { id: 'c', from: 'app' },
      { id: 'd', from: 'app' },
    ]);
    expect(() => applyDelta(base, { remove: ['z'] }, 'cella/a11y.app.ts')).toThrow(
      'cella/a11y.app.ts removes z, which the base does not have',
    );
  });
});
