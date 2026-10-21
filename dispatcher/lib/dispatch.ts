import { cardinalLabel, idleTimeoutSec, runnerLabels, sizeForLabels } from './config';
import { estimateCost } from './cost';
import type { RunnerDriver } from './drivers/types';
import { GitHubError, type generateJitConfig } from './github';

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

export interface Deps {
  driver: RunnerDriver;
  generateJitConfig: typeof generateJitConfig;
  /** Wall-clock deadline (epoch ms) after which this invocation may be killed. */
  deadline: number;
}

export type Plan =
  | { kind: 'ignore'; reason: string }
  | { kind: 'dispatch'; run: () => Promise<void> }
  | { kind: 'stop'; run: () => Promise<void> };

/** Margin left between handing off a long job and the function's own deadline. */
const HANDOFF_MARGIN_MS = 30_000;

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
  // JIT runners take any queued job with matching labels, so the runner may end up running a
  // sibling job. The name just has to be unique; it's also the sandbox name.
  const runnerName = `cardinal-${job.id}`;
  const size = sizeForLabels(job.labels);

  return {
    kind: 'dispatch',
    run: async () => {
      const queuedAt = Date.parse(job.created_at);
      let jit;
      try {
        jit = await deps.generateJitConfig({
          installationId: event.installation.id,
          owner,
          repo,
          name: runnerName,
          labels: runnerLabels(job.labels),
        });
      } catch (err) {
        // 409: a runner with this name exists, i.e. GitHub redelivered the queued event.
        if (err instanceof GitHubError && err.status === 409) {
          console.log('cardinal duplicate delivery, runner already exists', { runnerName });
          return;
        }
        throw err;
      }

      const runStart = Date.now();
      const result = await deps.driver.runOneJob({
        jitConfig: jit.encoded_jit_config,
        size,
        jobId: job.id,
        runnerName,
        idleTimeoutSec,
        watchMs: deps.deadline - HANDOFF_MARGIN_MS - Date.now(),
      });

      const summary = {
        runnerName,
        repo: `${owner}/${repo}`,
        driver: deps.driver.name,
        vcpus: size.vcpus,
        queueToBootMs: Number.isNaN(queuedAt) ? undefined : runStart + result.bootMs - queuedAt,
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
    },
  };
}
