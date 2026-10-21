import { APIError, Sandbox, type Command } from '@vercel/sandbox';
import type { RunnerDriver, RunOneJobInput, RunOneJobResult } from './types';

const ENTRYPOINT = '/home/runner/entrypoint.sh';

export const vercelSandboxDriver: RunnerDriver = {
  name: 'vercel-sandbox',

  async runOneJob({ jitConfig, size, runnerName, idleTimeoutSec, watchMs }: RunOneJobInput) {
    const started = Date.now();
    const sandbox = await Sandbox.create({
      // The sandbox name doubles as the handle `stop()` uses when workflow_job.completed arrives.
      name: runnerName,
      image: required('CARDINAL_IMAGE'),
      resources: { vcpus: size.vcpus },
      timeout: size.timeoutMs,
      persistent: false,
      networkPolicy: 'allow-all',
      tags: { app: 'cardinal' },
      ...(process.env.CARDINAL_REGION ? { region: process.env.CARDINAL_REGION as never } : {}),
    });
    const bootMs = Date.now() - started;
    console.log('cardinal sandbox up', { runnerName, bootMs });

    let handedOff = false;
    const watching = new AbortController();
    try {
      // Runs as the image's USER (`runner`). Not sudo: sudo would strip the env carrying the JIT config.
      const cmd = await sandbox.runCommand({
        cmd: 'bash',
        args: [ENTRYPOINT],
        env: { CARDINAL_JIT_CONFIG: jitConfig, CARDINAL_IDLE_TIMEOUT: String(idleTimeoutSec) },
        detached: true,
      });
      void streamLogs(cmd, runnerName, watching.signal);

      const budget = Math.max(0, watchMs - (Date.now() - started));
      const timer = setTimeout(() => watching.abort(), budget);
      try {
        const done = await cmd.wait({ signal: watching.signal });
        return await finish(sandbox, { exitCode: done.exitCode, handedOff, bootMs, started });
      } catch (err) {
        if (!watching.signal.aborted) throw err;
        handedOff = true;
        console.log('cardinal handing off long job', { runnerName, watchedMs: Date.now() - started });
        return { exitCode: null, handedOff, bootMs, durationMs: Date.now() - started };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      watching.abort();
      if (!handedOff) await sandbox.stop().catch(() => {});
    }
  },

  async stop(runnerName) {
    try {
      const sandbox = await Sandbox.get({ name: runnerName, resume: false });
      if (sandbox.status !== 'running' && sandbox.status !== 'pending') return false;
      await sandbox.stop();
      return true;
    } catch (err) {
      if (err instanceof APIError && err.response.status === 404) return false;
      throw err;
    }
  },
};

async function finish(
  sandbox: Sandbox,
  r: { exitCode: number; handedOff: boolean; bootMs: number; started: number },
): Promise<RunOneJobResult> {
  // Stop before reading usage: activeCpuUsageMs is only reported once the VM is stopped.
  await sandbox.stop();
  return {
    exitCode: r.exitCode,
    handedOff: r.handedOff,
    bootMs: r.bootMs,
    durationMs: Date.now() - r.started,
    activeCpuMs: sandbox.activeCpuUsageMs,
  };
}

async function streamLogs(cmd: Command, runnerName: string, signal: AbortSignal) {
  try {
    for await (const line of cmd.logs({ signal })) {
      const text = line.data.trimEnd();
      if (text) (line.stream === 'stderr' ? console.error : console.log)(`[${runnerName}] ${text}`);
    }
  } catch {
    // Log streaming is best-effort; it ends with an error when the sandbox stops.
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
