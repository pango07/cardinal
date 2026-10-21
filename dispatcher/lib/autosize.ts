/**
 * Auto-sizing for `runs-on: cardinal-auto`.
 *
 * Sandbox bills CPU by busy time and memory by provisioned vCPUs × wall-clock, so the cheapest size for a job is
 * the smallest one that keeps the CPUs busy. Every run measures its own utilisation; the recommendation rides on
 * the job's warm base as a `fit` tag and the next run boots at that size.
 */

export const AUTO_VCPUS = [1, 2, 4, 8] as const;
export const AUTO_DEFAULT_VCPUS = 2;
/** Above this utilisation the job was CPU-bound: give it more cores. */
export const STEP_UP_ABOVE = 0.85;
/** Below this, half the cores sat idle: take some away. */
export const STEP_DOWN_BELOW = 0.45;

export interface Fit {
  /** vCPUs the next run should use. */
  rec: number;
  /** vCPUs the measurement was taken at. */
  from: number;
  /** Never recommend below this; raised when a step-down was followed by a failure. */
  floor: number;
}

/** Tag value: `rec:from:floor`. */
export function parseFit(tag: string | undefined): Fit | undefined {
  if (!tag) return undefined;
  const parts = tag.split(':').map(Number);
  const [rec, from] = parts;
  const floor = parts[2] ?? 1;
  if (!AUTO_VCPUS.includes(rec as never) || !AUTO_VCPUS.includes(from as never) || !AUTO_VCPUS.includes(floor as never)) return undefined;
  return { rec, from, floor };
}

export function formatFit(f: Fit): string {
  return `${f.rec}:${f.from}:${f.floor}`;
}

export function utilisation(input: { vcpus: number; activeCpuMs: number; wallMs: number }): number {
  if (input.wallMs <= 0 || input.vcpus <= 0) return 0;
  return input.activeCpuMs / (input.vcpus * input.wallMs);
}

/** The size the next run should get, from this run's measurement and the floor carried on the base. */
export function nextFit(input: { vcpus: number; activeCpuMs: number; wallMs: number; floor?: number }): Fit {
  const floor = input.floor ?? 1;
  const i = AUTO_VCPUS.indexOf(input.vcpus as never);
  const util = utilisation(input);
  let rec = input.vcpus;
  if (i >= 0 && util > STEP_UP_ABOVE) rec = AUTO_VCPUS[Math.min(i + 1, AUTO_VCPUS.length - 1)];
  else if (i >= 0 && util < STEP_DOWN_BELOW) rec = AUTO_VCPUS[Math.max(i - 1, 0)];
  return { rec: Math.max(rec, floor), from: input.vcpus, floor };
}

/** After a failed run at a stepped-down size: go back up and never step below that again. */
export function lockAfterFailure(fit: Fit): Fit | undefined {
  if (fit.rec >= fit.from) return undefined;
  return { rec: fit.from, from: fit.from, floor: Math.max(fit.floor, fit.from) };
}
