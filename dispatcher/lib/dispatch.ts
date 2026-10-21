import { createHash } from 'node:crypto';
import { formatFit, lockAfterFailure, nextFit, parseFit, utilisation } from './autosize';
import { cardinalLabel, defaultImage, idleTimeoutSec, runnerLabels, sizeForLabels } from './config';
import { estimateCost } from './cost';
import type { RunnerDriver, RunnerSize, SandboxInfo } from './drivers/types';
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
    head_branch: string | null;
  };
  repository: { name: string; owner: { login: string }; default_branch: string };
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
/** Warm starts: fork each job from the last green run of the same job on the default branch. */
export const WARM = process.env.CARDINAL_WARM !== '0';
/** How long the completed handler waits for the dispatcher that ran the job to finish stopping it. */
const SETTLE_MS = 4_000;

/**
 * Decides what to do with a workflow_job event. Cheap and synchronous so the webhook can answer
 * GitHub immediately; the returned `run` does the slow part (under waitUntil).
 */
export function plan(event: WorkflowJobEvent, deps: Deps): Plan {
  const job = event.workflow_job;

  if (event.action === 'completed') {
    const runnerName = job.runner_name;
    if (!runnerName?.startsWith('cardinal-')) return { kind: 'ignore', reason: 'not a cardinal runner' };
    const owner = event.repository.owner.login;
    const repo = event.repository.name;
    return {
      kind: 'stop',
      run: async () => {
        const stopped = await deps.driver.stop(runnerName);
        if (stopped) console.log('cardinal stopped sandbox on job completion', { runnerName, jobId: job.id });
        const snaps = deps.driver.snapshots;
        if (!snaps || !WARM) return;
        if (!stopped) await sleep(SETTLE_MS); // the dispatcher that ran it is probably mid-stop; let the snapshot land
        const key = warmKey(owner, repo, job.name);
        const onDefault = job.head_branch === event.repository.default_branch;
        if (job.conclusion === 'success' && onDefault) {
          await snaps.setTags(runnerName, { role: 'base' });
          const bases = (await snaps.listTagged('warm', key)).filter((s) => s.tags.role === 'base' && s.name !== runnerName);
          await Promise.all(bases.map((s) => snaps.remove(s.name).catch(() => {})));
          console.log('cardinal warm base promoted', { repo: `${owner}/${repo}`, job: job.name, base: runnerName, replaced: bases.map((b) => b.name) });
        } else if (job.conclusion === 'success') {
          await snaps.remove(runnerName).catch((err) => console.warn('cardinal could not remove sandbox', { runnerName, err: String(err) }));
        } else {
          // Kept (until the snapshot TTL) so the failure can be opened and poked at.
          await snaps.setTags(runnerName, { role: 'failed' }).catch(() => {});
          console.log('cardinal kept failed job sandbox', { runnerName, conclusion: job.conclusion });
          const size = sizeForLabels(job.labels);
          if (size.auto) {
            // If this run was a step-down, assume the smaller box was the problem: go back up and floor there.
            const base = await findWarmBase(deps, key, size);
            const locked = base && lockAfterFailure(parseFit(base.tags.fit) ?? { rec: size.vcpus, from: size.vcpus, floor: 1 });
            if (base && locked) {
              await snaps.setTags(base.name, { fit: formatFit(locked) }).catch(() => {});
              console.log('cardinal auto-size floored after failure', { job: job.name, base: base.name, fit: formatFit(locked) });
            }
          }
        }
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

export function warmKey(owner: string, repo: string, jobName: string): string {
  return 'w' + createHash('sha1').update(`${owner}/${repo}#${jobName}`).digest('hex').slice(0, 20);
}

const tagSafe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60);

function imageTag(size: RunnerSize): string {
  return tagSafe(size.image ?? defaultImage());
}

/** The newest green default-branch sandbox for this job, built from the image we'd boot today. */
async function findWarmBase(deps: Deps, key: string, size: RunnerSize): Promise<SandboxInfo | undefined> {
  const snaps = deps.driver.snapshots;
  if (!snaps || !WARM) return undefined;
  try {
    const img = imageTag(size);
    return (await snaps.listTagged('warm', key)).find((s) => s.tags.role === 'base' && s.status === 'stopped' && s.tags.img === img);
  } catch (err) {
    console.warn('cardinal warm base lookup failed', { key, err: String(err) });
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
            jobName: j.name,
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
  const stale = (job: { created_at: string }) => Date.now() - Date.parse(job.created_at) >= SWEEP_MIN_QUEUED_MS;
  for (const job of queued) {
    if (!cardinalLabel(job.labels) || !stale(job)) continue;
    const match = idle.findIndex((r) => covers(r, job.labels));
    if (match >= 0) {
      idle.splice(match, 1); // one idle runner serves one job
      continue;
    }
    // A fresh name: the first attempt's registration may linger on GitHub and its sandbox may be kept as a snapshot.
    try {
      await dispatchJob(deps, installationId, owner, repo, job, `cardinal-${job.id}-r${Date.now().toString(36)}`);
      dispatched++;
    } catch (err) {
      console.error('cardinal sweep could not re-dispatch', { repo: `${owner}/${repo}`, jobId: job.id, err: String(err) });
    }
  }

  // Dead registrations: offline cardinal-* runners. A JIT runner is "offline" from the moment it's minted until it
  // connects, so skip anything that may still be booting: compute the driver reports as running, and runners for
  // jobs queued too recently for the sweep to own.
  const booting = new Set<string>();
  if (deps.driver.snapshots) {
    for (const s of await deps.driver.snapshots.listTagged('app', 'cardinal')) {
      if (s.status !== 'stopped' && s.status !== 'failed' && s.status !== 'aborted') booting.add(s.name);
    }
  }
  const freshJobs = new Set(queued.filter((j) => !stale(j)).map((j) => `cardinal-${j.id}`));
  for (const r of runners) {
    if (!r.name.startsWith('cardinal-') || r.status !== 'offline') continue;
    if (booting.has(r.name) || freshJobs.has(r.name.replace(/-r[0-9a-z]+$/, ''))) continue;
    await deps.deleteRunner(installationId, owner, repo, r.id).catch(() => {});
    removed++;
  }
  return { dispatched, removed };
}

/**
 * Housekeeping across all of this project's sandboxes: records that no decision will ever come for.
 * Bases and fresh failures are kept; the snapshot TTL bounds everything else.
 */
export async function sweepSandboxes(deps: Deps): Promise<{ removed: string[] }> {
  const snaps = deps.driver.snapshots;
  if (!snaps) return { removed: [] };
  const now = Date.now();
  const removed: string[] = [];
  for (const s of await snaps.listTagged('app', 'cardinal')) {
    if (s.status !== 'stopped' && s.status !== 'failed' && s.status !== 'aborted') continue;
    const age = now - s.createdAt;
    const role = s.tags.role;
    const stale =
      role === 'base' ? false
      : role === 'failed' ? age > FAILED_KEEP_MS
      : role === 'open' ? age > OPEN_KEEP_MS
      : age > UNDECIDED_KEEP_MS; // 'job' with no completed webhook, speculative runners, or pre-tag records
    if (!stale) continue;
    await snaps.remove(s.name).catch(() => {});
    removed.push(s.name);
  }
  return { removed };
}

const FAILED_KEEP_MS = Number(process.env.CARDINAL_SNAPSHOT_DAYS ?? 7) * 24 * 3_600_000;
const OPEN_KEEP_MS = 60 * 60_000;
const UNDECIDED_KEEP_MS = 30 * 60_000;

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

async function dispatchJob(
  deps: Deps,
  installationId: number,
  owner: string,
  repo: string,
  job: Pick<JobSummary, 'id' | 'name' | 'labels' | 'created_at'>,
  runnerName = `cardinal-${job.id}`,
) {
  // JIT runners take any queued job with matching labels, so the runner may end up running a
  // sibling job. The name just has to be unique; it's also the sandbox name.
  await startRunner(deps, installationId, owner, repo, {
    runnerName,
    jobName: job.name,
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
  opts: { runnerName: string; jobName: string; labels: string[]; idleTimeoutSec: number; tags?: Record<string, string>; queuedAt: number | undefined },
) {
  const { runnerName, labels } = opts;
  let size = sizeForLabels(labels);
  const key = warmKey(owner, repo, opts.jobName);
  const base = await findWarmBase(deps, key, size);
  const forkFrom = base?.name;
  const persist = deps.driver.snapshots && WARM ? { forkFrom } : undefined;
  // cardinal-auto: boot at the size the last green run of this job recommended.
  const baseFit = size.auto ? parseFit(base?.tags.fit) : undefined;
  if (baseFit) size = { ...size, vcpus: baseFit.rec, memoryMb: baseFit.rec * 2048 };

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
      tags: { ...opts.tags, ...(persist ? { warm: key, role: 'job', img: imageTag(size) } : {}) },
      persist,
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

  // Measure this run and leave the recommendation on its sandbox; if it becomes the base, the next run uses it.
  let fit = baseFit;
  if (size.auto && !result.handedOff && result.activeCpuMs !== undefined) {
    fit = nextFit({ vcpus: size.vcpus, activeCpuMs: result.activeCpuMs, wallMs: result.durationMs, floor: baseFit?.floor });
  }
  if (size.auto && fit && persist && deps.driver.snapshots) {
    await deps.driver.snapshots.setTags(runnerName, { fit: formatFit(fit) }).catch((err) => console.warn('cardinal could not tag fit', { runnerName, err: String(err) }));
  }

  const summary = {
    runnerName,
    repo: `${owner}/${repo}`,
    driver: deps.driver.name,
    vcpus: size.vcpus,
    utilisation: result.handedOff || result.activeCpuMs === undefined ? undefined : Number(utilisation({ vcpus: size.vcpus, activeCpuMs: result.activeCpuMs, wallMs: result.durationMs }).toFixed(2)),
    nextVcpus: size.auto && fit ? fit.rec : undefined,
    speculative: Boolean(opts.tags?.spec),
    warmStart: result.forkedFrom ?? false,
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
