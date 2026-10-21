export interface RunnerSize {
  vcpus: number;
  memoryMb: number;
  timeoutMs: number;
  /** Image to boot instead of the default runner image (e.g. the android variant). */
  image?: string;
  /** vcpus/memoryMb are a starting point; the dispatcher resizes from measured utilisation. */
  auto?: boolean;
}

export interface RunOneJobInput {
  /** May still be in flight: drivers create the VM first and await this before starting the runner. */
  jitConfig: string | Promise<string>;
  size: RunnerSize;
  jobId: number;
  runnerName: string;
  /** Seconds the runner waits for a job before shutting itself down. */
  idleTimeoutSec: number;
  /** Extra tags for the compute (driver-dependent, best effort). */
  tags?: Record<string, string>;
  /**
   * How long the caller can stay alive to babysit the job. If the job outlives this,
   * runOneJob returns with `handedOff: true` and the compute is left running; the
   * `workflow_job.completed` webhook (via `stop`) or the compute timeout tears it down.
   */
  watchMs: number;
  /**
   * Keep the filesystem when the runner exits (a snapshot), so the `completed` webhook can turn it into a
   * warm base, keep it for inspection, or delete it. `forkFrom` starts from another sandbox's snapshot.
   */
  persist?: { forkFrom?: string };
}

export interface RunOneJobResult {
  /** Runner process exit code, or null if the job was still running when we handed off. */
  exitCode: number | null;
  handedOff: boolean;
  bootMs: number;
  durationMs: number;
  /** Driver-specific usage figures for the cost summary, when known. */
  activeCpuMs?: number;
  forkedFrom?: string;
}

export interface SandboxInfo {
  name: string;
  status: string;
  createdAt: number;
  tags: Record<string, string>;
}

/** Snapshot-capable drivers: warm starts and keep-on-failure. */
export interface SnapshotOps {
  /** Compute with `tag`, newest first. */
  listTagged(key: string, value: string): Promise<SandboxInfo[]>;
  setTags(name: string, tags: Record<string, string>): Promise<void>;
  /** Removes compute and its snapshots. Idempotent. */
  remove(name: string): Promise<void>;
}

export interface RunnerDriver {
  readonly name: string;
  /** Boot compute, run exactly one job, tear down (unless handed off, see RunOneJobInput.watchMs). */
  runOneJob(input: RunOneJobInput): Promise<RunOneJobResult>;
  /** Tear down the compute for a runner. Returns false if there was nothing running. Idempotent. */
  stop(runnerName: string): Promise<boolean>;
  snapshots?: SnapshotOps;
}
