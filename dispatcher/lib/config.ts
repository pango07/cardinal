import type { RunnerSize } from './drivers/types';

const timeoutMs = Number(process.env.CARDINAL_TIMEOUT_MINUTES ?? 60) * 60_000;

// Sandbox memory is fixed at 2048 MB per vCPU; memoryMb is informational (cost estimates).
export const SIZES: Record<string, RunnerSize> = {
  'cardinal':    { vcpus: 2, memoryMb: 4096,  timeoutMs },
  'cardinal-4x': { vcpus: 4, memoryMb: 8192,  timeoutMs },
  'cardinal-8x': { vcpus: 8, memoryMb: 16384, timeoutMs },
  // JDK 21 + Android SDK baked in (image/Dockerfile, `android` stage). Gradle + Kotlin want the memory.
  'cardinal-android': { vcpus: 8, memoryMb: 16384, timeoutMs, image: process.env.CARDINAL_IMAGE_ANDROID },
};

// Labels every self-hosted runner gets implicitly. They may appear in `runs-on` but must not be
// passed to generate-jitconfig.
const DEFAULT_LABELS = new Set(['self-hosted', 'linux', 'x64']);

/** The Cardinal size label a job asked for, or undefined if the job isn't ours. */
export function cardinalLabel(labels: string[]): string | undefined {
  return labels.find((l) => l in SIZES);
}

export function sizeForLabels(labels: string[]): RunnerSize {
  const label = cardinalLabel(labels);
  if (label === 'cardinal') return SIZES[process.env.CARDINAL_DEFAULT_SIZE ?? 'cardinal'] ?? SIZES.cardinal;
  return SIZES[label ?? 'cardinal'];
}

export function runnerLabels(labels: string[]): string[] {
  return labels.filter((l) => !DEFAULT_LABELS.has(l.toLowerCase()));
}

export const idleTimeoutSec = Number(process.env.CARDINAL_IDLE_TIMEOUT_SECONDS ?? 300);
