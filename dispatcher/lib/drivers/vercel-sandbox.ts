import { APIError, Sandbox, type Command } from '@vercel/sandbox';
import type { RunnerDriver, RunOneJobInput, RunOneJobResult, SandboxInfo } from './types';

const ENTRYPOINT = '/home/runner/entrypoint.sh';
const SNAPSHOT_TTL_MS = Number(process.env.CARDINAL_SNAPSHOT_DAYS ?? 7) * 24 * 3_600_000;

export const vercelSandboxDriver: RunnerDriver = {
  name: 'vercel-sandbox',

  async runOneJob({ jitConfig, size, runnerName, idleTimeoutSec, watchMs, tags, persist }: RunOneJobInput) {
    const started = Date.now();
    const image = size.image ?? required('CARDINAL_IMAGE');
    const common = {
      // The sandbox name doubles as the handle `stop()` uses when workflow_job.completed arrives.
      name: runnerName,
      resources: { vcpus: size.vcpus },
      timeout: size.timeoutMs,
      networkPolicy: 'allow-all' as const,
      tags: { app: 'cardinal', ...tags },
      ...(process.env.CARDINAL_REGION ? { region: process.env.CARDINAL_REGION as never } : {}),
      ...(persist
        ? { persistent: true, snapshotExpiration: SNAPSHOT_TTL_MS, keepLastSnapshots: { count: 1, expiration: SNAPSHOT_TTL_MS } }
        : { persistent: false }),
    };
    let forkedFrom: string | undefined;
    let sandbox: Sandbox;
    if (persist?.forkFrom) {
      try {
        sandbox = await Sandbox.fork({ sourceSandbox: persist.forkFrom, ...common });
        forkedFrom = persist.forkFrom;
      } catch (err) {
        // The base vanished or can't be forked right now: a cold start is always available.
        console.warn('cardinal warm start failed, booting cold', { runnerName, from: persist.forkFrom, err: String(err) });
        sandbox = await Sandbox.create({ image, ...common });
      }
    } else {
      sandbox = await Sandbox.create({ image, ...common });
    }
    const bootMs = Date.now() - started;
    console.log('cardinal sandbox up', { runnerName, bootMs, forkedFrom });

    let handedOff = false;
    const watching = new AbortController();
    try {
      // Runs as the image's USER (`runner`). Not sudo: sudo would strip the env carrying the JIT config.
      const cmd = await sandbox.runCommand({
        cmd: 'bash',
        args: [ENTRYPOINT],
        env: { CARDINAL_JIT_CONFIG: await jitConfig, CARDINAL_IDLE_TIMEOUT: String(idleTimeoutSec) },
        detached: true,
      });
      void streamLogs(cmd, runnerName, watching.signal);

      const budget = Math.max(0, watchMs - (Date.now() - started));
      const timer = setTimeout(() => watching.abort(), budget);
      try {
        const done = await cmd.wait({ signal: watching.signal });
        if (persist) await scrub(sandbox);
        return await finish(sandbox, { exitCode: done.exitCode, handedOff, bootMs, started, forkedFrom });
      } catch (err) {
        if (!watching.signal.aborted) throw err;
        handedOff = true;
        console.log('cardinal handing off long job', { runnerName, watchedMs: Date.now() - started });
        return { exitCode: null, handedOff, bootMs, durationMs: Date.now() - started, forkedFrom };
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
      if (sandbox.persistent) await scrub(sandbox).catch(() => {});
      await sandbox.stop();
      return true;
    } catch (err) {
      if (err instanceof APIError && err.response.status === 404) return false;
      throw err;
    }
  },

  snapshots: {
    async listTagged(key, value): Promise<SandboxInfo[]> {
      // The SDK types the filter as a single literal key; ours is computed.
      const page = await Sandbox.list({ tags: { [key]: value } as never, sortBy: 'createdAt', sortOrder: 'desc', limit: 20 });
      const all = await page.toArray();
      return all.map((s) => ({ name: s.name, status: s.status, createdAt: s.createdAt, tags: s.tags ?? {} }));
    },
    async setTags(name, tags) {
      const sandbox = await Sandbox.get({ name, resume: false });
      await sandbox.update({ tags: { ...(sandbox.tags ?? {}), ...tags } });
    },
    async remove(name) {
      try {
        const sandbox = await Sandbox.get({ name, resume: false });
        if (sandbox.status === 'running' || sandbox.status === 'pending') await sandbox.stop().catch(() => {});
        await sandbox.delete({ deleteOrphanSnapshots: true });
      } catch (err) {
        if (err instanceof APIError && err.response.status === 404) return;
        throw err;
      }
    },
  },
};

/** Before a filesystem is kept: drop the runner's per-job temp and logs, which can hold job secrets. */
async function scrub(sandbox: Sandbox) {
  await sandbox.runCommand('bash', ['-c', 'rm -rf /home/runner/_work/_temp /home/runner/_diag /home/runner/_work/_actions/_temp 2>/dev/null; true'], { timeoutMs: 30_000 });
}

async function finish(
  sandbox: Sandbox,
  r: { exitCode: number; handedOff: boolean; bootMs: number; started: number; forkedFrom?: string },
): Promise<RunOneJobResult> {
  // Stop before reading usage: activeCpuUsageMs is only reported once the VM is stopped.
  await sandbox.stop();
  return {
    exitCode: r.exitCode,
    handedOff: r.handedOff,
    bootMs: r.bootMs,
    durationMs: Date.now() - r.started,
    activeCpuMs: sandbox.activeCpuUsageMs,
    forkedFrom: r.forkedFrom,
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
