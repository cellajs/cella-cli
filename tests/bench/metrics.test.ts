import { describe, expect, it } from 'vitest';
import { Metrics } from '../../src/bench/metrics';

describe('Metrics', () => {
  it('keeps sub-millisecond latencies: values are recorded in microseconds', () => {
    const metrics = new Metrics();
    for (const value of [0.25, 0.5, 1.5, 2.5]) metrics.histogram('lat', value);
    const d = metrics.distribution('lat');
    expect(d?.count).toBe(4);
    expect(d?.min).toBeCloseTo(0.25, 2);
    expect(d?.max).toBeCloseTo(2.5, 2);
    expect(d?.p50).toBeCloseTo(0.5, 2);
  });
});
