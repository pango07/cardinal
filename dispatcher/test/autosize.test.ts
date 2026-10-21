import { describe, expect, it } from 'vitest';
import { formatFit, lockAfterFailure, nextFit, parseFit, utilisation } from '@/lib/autosize';

describe('autosize', () => {
  it('round-trips the tag and rejects junk', () => {
    expect(parseFit('4:2:1')).toEqual({ rec: 4, from: 2, floor: 1 });
    expect(parseFit('2:2')).toEqual({ rec: 2, from: 2, floor: 1 });
    expect(formatFit({ rec: 1, from: 2, floor: 1 })).toBe('1:2:1');
    expect(parseFit(undefined)).toBeUndefined();
    expect(parseFit('3:2:1')).toBeUndefined();
    expect(parseFit('lol')).toBeUndefined();
  });

  it('measures utilisation as busy CPU over provisioned CPU-time', () => {
    expect(utilisation({ vcpus: 4, activeCpuMs: 20_000, wallMs: 10_000 })).toBe(0.5);
    expect(utilisation({ vcpus: 2, activeCpuMs: 0, wallMs: 0 })).toBe(0);
  });

  it('steps down below 45%, up above 85%, holds in between, clamps at 1 and 8', () => {
    const at = (vcpus: number, util: number, floor?: number) => nextFit({ vcpus, activeCpuMs: util * vcpus * 1000, wallMs: 1000, floor }).rec;
    expect(at(4, 0.3)).toBe(2);
    expect(at(4, 0.6)).toBe(4);
    expect(at(4, 0.9)).toBe(8);
    expect(at(8, 0.99)).toBe(8);
    expect(at(1, 0.1)).toBe(1);
    expect(at(4, 0.3, 4)).toBe(4);
  });

  it('locks only after a step-down', () => {
    expect(lockAfterFailure({ rec: 1, from: 2, floor: 1 })).toEqual({ rec: 2, from: 2, floor: 2 });
    expect(lockAfterFailure({ rec: 2, from: 2, floor: 1 })).toBeUndefined();
    expect(lockAfterFailure({ rec: 4, from: 2, floor: 1 })).toBeUndefined();
  });
});
