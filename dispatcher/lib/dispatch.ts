import { cardinalLabel, idleTimeoutSec, runnerLabels, sizeForLabels } from './config';
import { estimateCost } from './cost';
import type { RunnerDriver } from './drivers/types';
import {
  GitHubError,
  type JobSummary,
  type RepoRunner,
  type deleteRunner,
  type generateJitConfig,
  type getJob,
  type lastRunJobs,
  type queuedJobs,
  type repoRunners,
} from './github';

export interface WorkflowJobEvent {
  action: 'queued' | 'waiting' | 'in_progress' | 'completed';
  workflow_job: {
    id: number;
    run_id: number;
    name: string;
    labels: string[];
    runner_name: string | null;
    created_at: string;
    conclusion: string | null;
  };
  repository: { name: string; owner: { login: string } };
  installation: { id: number };
}

export interface PushEvent {
  ref: string;
  after: string;
  deleted: boolean;
  repository: { name: string; owner: { login: string } };
  installation: { id: number };
}

export interface Deps {
  driver: RunnerDriver;
  generateJitConfig: typeof generateJitConfig;
  getJob: typeof getJob;
  repoRunners: typeof repoRunners;
  lastRunJobs: typeof lastRunJobs;
  queuedJobs: typeof queuedJobs;
  deleteRunner: typeof deleteRunner;
  /** Wall-clock deadline (epoch ms) after which this invocation may be killed. */
  deadline: number;
}

export type Plan =
  | { kind: 'ignore'; reason: string }
  | { kind: 'dispatch'; run: () => Promise<void> }
  | { kind: 'preboot'; run: () => Promise<void> }
  | { kind: 'stop'; run: () => Promise<void> };

/** Margin left between handing off a long job and the function's own deadline. */
const HANDOFF_MARGIN_MS = 30_000;
/** Speculative runners wait this long for a job before giving up. Memory bills a 1-minute minimum anyway. */
export const SPEC_IDLE_SEC = Number(process.env.CARDINAL_SPEC_IDLE_SECONDS ?? 90);
/** Cap on speculative runners per push. */
const SPEC_MAX = Number(process.env.CARDINAL_SPEC_MAX ?? 4);
/** The sweep re-dispatches a job that has been queued at least this long with no runner coming for it. */
export const SWEEP_MIN_QUEUED_MS = 45_000;

const SPEC_PREFIX = 'cardinal-spec-';

/**
 * Decides what to do with a workflow_job event. Cheap and synchronous so the webhook can answer
 * GitHub immediately; the returned `run` does the slow part (under waitUntil).
 */
export function plan(event: WorkflowJobEvent, deps: Deps): Plan {
  const job = event.workflow_job;

  if (event.action === 'completed') {
    const runnerName = job.runner_name;
    if (!runnerName?.startsWith('cardinal-')) return { kind: 'ignore', reason: 'not a cardinal runner' };
    return {
      kind: 'stop',
      run: async () => {
        const stopped = await deps.driver.stop(runnerName);
        if (stopped) console.log('cardinal stopped sandbox on job completion', { runnerName, jobId: job.id });
      },
    };
  }

  if (event.action !== 'queued') return { kind: 'ignore', reason: `action ${event.action}` };
  if (!cardinalLabel(job.labels)) return { kind: 'ignore', reason: 'no cardinal label' };

  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  return {
    kind: 'dispatch',
    run: async () => {
      // A speculative runner booted on `push` may already have this job, or be idle and about to get it.
      const covered = await alreadyCovered(deps, event.installation.id, owner, repo, job.id, job.labels);
      if (covered) {
        console.log('cardinal job covered by speculative runner', { jobId: job.id, repo: `${owner}/${repo}`, covered });
        return;
      }
      await dispatchJob(deps, event.installation.id, owner, repo, job);
    },
  };
}

/** The push handler: boot runners for the jobs this push is about to queue, before GitHub queues them. */
export function planPush(event: PushEvent, deps: Deps): Plan {
  if (event.deleted || !event.ref.startsWith('refs/heads/')) return { kind: 'ignore', reason: 'not a branch push' };
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const branch = event.ref.slice('refs/heads/'.length);
  return {
    kind: 'preboot',
    run: async () => {
      const previous = await deps.lastRunJobs(event.installation.id, owner, repo, branch);
      const predicted = previous.filter((j) => cardinalLabel(j.labels)).slice(0, SPEC_MAX);
      if (!predicted.length) return;
      console.log('cardinal pre-booting', { repo: `${owner}/${repo}`, branch, jobs: predicted.map((j) => j.name) });
      await Promise.all(
        predicted.map((j, i) => {
          const runnerName = `${SPEC_PREFIX}${event.after.slice(0, 7)}-${i}`;
          return startRunner(deps, event.installation.id, owner, repo, {
            runnerName,
            labels: j.labels,
            idleTimeoutSec: SPEC_IDLE_SEC,
            tags: { spec: '1' },
            queuedAt: undefined,
          });
        }),
      );
    },
  };
}

/**
 * The once-a-minute safety net: any cardinal job queued for a while with no runner coming gets one, and
 * runners that died without deregistering are removed.
 */
export async function sweepRepo(deps: Deps, installationId: number, owner: string, repo: string): Promise<{ dispatched: number; removed: number }> {
  let dispatched = 0;
  let removed = 0;
  const [queued, runners] = await Promise.all([
    deps.queuedJobs(installationId, owner, repo),
    deps.repoRunners(installationId, owner, repo),
  ]);
  const idle = runners.filter((r) => r.status === 'online' && !r.busy);
  for (const job of queued) {
    if (!cardinalLabel(job.labels)) continue;
    if (Date.now() - Date.parse(job.created_at) < SWEEP_MIN_QUEUED_MS) continue;
    const match = idle.findIndex((r) => covers(r, job.labels));
    if (match >= 0) {
      idle.splice(match, 1); // one idle runner serves one job
      continue;
    }
    await dispatchJob(deps, installationId, owner, repo, job);
    dispatched++;
  }
  for (const r of runners) {
    if (r.name.startsWith('cardinal-') && r.status === 'offline') {
      await deps.deleteRunner(installationId, owner, repo, r.id).catch(() => {});
      removed++;
    }
  }
  return { dispatched, removed };
}

// ---------------------------------------------------------------------------------------------------

async function alreadyCovered(deps: Deps, installationId: number, owner: string, repo: string, jobId: number, labels: string[]) {
  const [job, runners] = await Promise.all([
    deps.getJob(installationId, owner, repo, jobId),
    deps.repoRunners(installationId, owner, repo),
  ]);
  if (job.status !== 'queued') return `job already ${job.status} on ${job.runner_name ?? 'a runner'}`;
  const idle = runners.find((r) => r.name.startsWith(SPEC_PREFIX) && r.status === 'online' && !r.busy && covers(r, labels));
  return idle ? `idle ${idle.name}` : null;
}

function covers(runner: RepoRunner, jobLabels: string[]): boolean {
  const have = new Set(runner.labels.map((l) => l.name.toLowerCase()));
  return runnerLabels(jobLabels).every((l) => have.has(l.toLowerCase()));
}

async function dispatchJob(deps: Deps, installationId: number, owner: string, repo: string, job: Pick<JobSummary, 'id' | 'labels' | 'created_at'>) {
  // JIT runners take any queued job with matching labels, so the runner may end up running a
  // sibling job. The name just has to be unique; it's also the sandbox name.
  await startRunner(deps, installationId, owner, repo, {
    runnerName: `cardinal-${job.id}`,
    labels: job.labels,
    idleTimeoutSec,
    queuedAt: Date.parse(job.created_at),
  });
}

async function startRunner(
  deps: Deps,
  installationId: number,
  owner: string,
  repo: string,
  opts: { runnerName: string; labels: string[]; idleTimeoutSec: number; tags?: Record<string, string>; queuedAt: number | undefined },
) {
  const { runnerName, labels } = opts;
  const size = sizeForLabels(labels);

  // Mint the token while the VM boots; the driver awaits it before starting the runner.
  const jit = deps
    .generateJitConfig({ installationId, owner, repo, name: runnerName, labels: runnerLabels(labels) })
    .then((j) => j.encoded_jit_config);
  jit.catch(() => {}); // surfaced through the driver's await, not as an unhandled rejection

  const runStart = Date.now();
  let result;
  try {
    result = await deps.driver.runOneJob({
      jitConfig: jit,
      size,
      jobId: 0,
      runnerName,
      idleTimeoutSec: opts.idleTimeoutSec,
      tags: opts.tags,
      watchMs: deps.deadline - HANDOFF_MARGIN_MS - Date.now(),
    });
  } catch (err) {
    // 409: a runner with this name exists, i.e. GitHub redelivered the event or the sweep raced the webhook.
    if (err instanceof GitHubError && err.status === 409) {
      console.log('cardinal runner already exists', { runnerName });
      return;
    }
    throw err;
  }

  const summary = {
    runnerName,
    repo: `${owner}/${repo}`,
    driver: deps.driver.name,
    vcpus: size.vcpus,
    speculative: Boolean(opts.tags?.spec),
    queueToBootMs: opts.queuedAt === undefined || Number.isNaN(opts.queuedAt) ? undefined : runStart + result.bootMs - opts.queuedAt,
    bootMs: result.bootMs,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    handedOff: result.handedOff,
    activeCpuMs: result.activeCpuMs,
    estCostUsd: result.handedOff
      ? undefined
      : Number(estimateCost({ activeCpuMs: result.activeCpuMs, memoryMb: size.memoryMb, wallMs: result.durationMs }).toFixed(4)),
  };
  console.log(`cardinal job summary ${JSON.stringify(summary)}`);
}
