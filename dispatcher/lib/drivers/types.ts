export interface RunnerSize {
  vcpus: number;
  memoryMb: number;
  timeoutMs: number;
}

export interface RunOneJobInput {
  jitConfig: string;
  size: RunnerSize;
  jobId: number;
  runnerName: string;
  /** Seconds the runner waits for a job before shutting itself down. */
  idleTimeoutSec: number;
  /**
   * How long the caller can stay alive to babysit the job. If the job outlives this,
   * runOneJob returns with `handedOff: true` and the compute is left running; the
   * `workflow_job.completed` webhook (via `stop`) or the compute timeout tears it down.
   */
  watchMs: number;
}

export interface RunOneJobResult {
  /** Runner process exit code, or null if the job was still running when we handed off. */
  exitCode: number | null;
  handedOff: boolean;
  bootMs: number;
  durationMs: number;
  /** Driver-specific usage figures for the cost summary, when known. */
  activeCpuMs?: number;
}

export interface RunnerDriver {
  readonly name: string;
  /** Boot compute, run exactly one job, tear down (unless handed off, see RunOneJobInput.watchMs). */
  runOneJob(input: RunOneJobInput): Promise<RunOneJobResult>;
  /** Tear down the compute for a runner. Returns false if there was nothing running. Idempotent. */
  stop(runnerName: string): Promise<boolean>;
}
