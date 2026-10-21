import { describe, expect, it } from 'vitest';
import { cardinalLabel, runnerLabels, sizeForLabels } from '@/lib/config';

describe('label routing', () => {
  it('only claims exact cardinal size labels', () => {
    expect(cardinalLabel(['cardinal'])).toBe('cardinal');
    expect(cardinalLabel(['self-hosted', 'cardinal-4x'])).toBe('cardinal-4x');
    expect(cardinalLabel(['ubuntu-latest'])).toBeUndefined();
    expect(cardinalLabel(['cardinals'])).toBeUndefined();
  });
  it('maps labels to sizes with 2048 MB per vCPU', () => {
    expect(sizeForLabels(['cardinal']).vcpus).toBe(2);
    expect(sizeForLabels(['cardinal-8x'])).toMatchObject({ vcpus: 8, memoryMb: 16384 });
  });
  it('strips implicit self-hosted labels before generate-jitconfig', () => {
    expect(runnerLabels(['self-hosted', 'Linux', 'X64', 'cardinal-4x'])).toEqual(['cardinal-4x']);
  });
});
