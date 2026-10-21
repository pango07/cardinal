// One job, one VM: clone the base, boot, hand the runner its JIT config over SSH, wait, delete.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config, vmPrefix } from './config.ts';
import { tryRun } from './exec.ts';
import { GitHubError, generateJitConfig, type QueuedJob } from './github.ts';
import { log } from './log.ts';
import { boot, ssh, sshArgs, stopAndDelete, tart, waitForIp, waitForSsh } from './tart.ts';

export async function runOneJob(job: QueuedJob): Promise<void> {
  const runnerName = `cardinal-mac-${job.id}`;
  const vm = `${vmPrefix}${job.id}`;
  const started = Date.now();

  let jit;
  try {
    jit = await generateJitConfig(job.repo, runnerName, config.runnerLabels);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 409) {
      log(runnerName, 'runner already registered, skipping');
      return;
    }
    throw err;
  }

  await tart('clone', config.baseVm, vm);
  const proc = boot(vm);
  const killer = setTimeout(() => {
    log(runnerName, `job timeout after ${config.jobTimeoutMs / 60_000} min, stopping VM`);
    void tryRun(config.tart, ['stop', vm]);
  }, config.jobTimeoutMs);

  try {
    const ip = await waitForIp(vm);
    await waitForSsh(ip);
    const bootMs = Date.now() - started;
    log(runnerName, `VM up at ${ip}`, { bootMs, job: job.html_url });

    const exitCode = await runRunner(ip, jit.encoded_jit_config, runnerName);
    log(runnerName, `job summary ${JSON.stringify({ repo: job.repo, jobId: job.id, bootMs, durationMs: Date.now() - started, exitCode })}`);
  } finally {
    clearTimeout(killer);
    await stopAndDelete(vm, proc);
    log(runnerName, 'VM deleted');
  }
}

/** Starts the runner over SSH (JIT config via stdin, never argv), streams its output, enforces the idle timeout. */
function runRunner(ip: string, jitConfig: string, runnerName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [...sshArgs(ip), 'IFS= read -r JIT; cd ~/actions-runner && exec ./run.sh --jitconfig "$JIT"'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdin.end(jitConfig + '\n');

    let running = false;
    let idle: NodeJS.Timeout | undefined;
    const onLine = (line: string) => {
      if (line.trim()) console.log(`[${runnerName}] ${line}`);
      if (line.includes('Listening for Jobs') && !running && !idle) {
        idle = setTimeout(() => {
          log(runnerName, `no job within ${config.idleTimeoutMs / 1000}s, stopping runner`);
          void ssh(ip, 'pkill -TERM -f Runner.Listener').catch(() => {});
        }, config.idleTimeoutMs);
      }
      if (line.includes('Running job:')) {
        running = true;
        if (idle) clearTimeout(idle);
      }
    };
    createInterface({ input: child.stdout }).on('line', onLine);
    createInterface({ input: child.stderr }).on('line', onLine);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (idle) clearTimeout(idle);
      resolve(code ?? 1);
    });
  });
}
