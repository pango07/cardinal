// iad1 Pro rates (Sept 2026 pricing page).
const CPU_PER_HOUR = 0.128;
const MEMORY_PER_GB_HOUR = 0.0212;
const HOUR_MS = 3_600_000;

/** Estimated sandbox cost in USD. Memory bills on wall time with a 1-minute minimum. */
export function estimateCost(input: { activeCpuMs?: number; memoryMb: number; wallMs: number }): number {
  const cpu = ((input.activeCpuMs ?? 0) / HOUR_MS) * CPU_PER_HOUR;
  const memory = (input.memoryMb / 1024) * (Math.max(input.wallMs, 60_000) / HOUR_MS) * MEMORY_PER_GB_HOUR;
  return cpu + memory;
}
