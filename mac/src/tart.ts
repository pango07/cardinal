import type { ChildProcess } from 'node:child_process';
import { config, sshKeyPath } from './config.ts';
import { run, sleep, start, tryRun } from './exec.ts';

export const tart = (...args: string[]) => run(config.tart, args, { timeoutMs: 10 * 60_000 });

export async function listVms(): Promise<{ name: string; running: boolean; source: string }[]> {
  const out = await tart('list', '--format', 'json');
  return (JSON.parse(out) as { Name: string; State: string; Source: string }[]).map((v) => ({
    name: v.Name,
    running: v.State === 'running',
    source: v.Source,
  }));
}

export async function vmExists(name: string): Promise<boolean> {
  return (await listVms()).some((v) => v.name === name);
}

/** Boots the VM headless. Returns the `tart run` process; the VM is gone when it exits. */
export function boot(name: string): ChildProcess {
  return start(config.tart, ['run', '--no-graphics', name]);
}

export async function waitForIp(name: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await tryRun(config.tart, ['ip', name, '--wait', '5'], { timeoutMs: 15_000 });
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    await sleep(2000);
  }
  throw new Error(`${name}: no IP after ${timeoutMs / 1000}s`);
}

export const sshArgs = (ip: string) => [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR',
  '-o', 'ConnectTimeout=10',
  '-i', sshKeyPath,
  `${config.guestUser}@${ip}`,
];

export async function waitForSsh(ip: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await tryRun('ssh', [...sshArgs(ip), 'true'], { timeoutMs: 15_000 })) !== null) return;
    await sleep(2000);
  }
  throw new Error(`${ip}: ssh not reachable after ${timeoutMs / 1000}s`);
}

export const ssh = (ip: string, command: string, timeoutMs = 10 * 60_000) =>
  run('ssh', [...sshArgs(ip), command], { timeoutMs });

/** Stops a VM and waits for its `tart run` process to exit. Safe to call when it's already stopped. */
export async function stopVm(name: string, proc?: ChildProcess): Promise<void> {
  await tryRun(config.tart, ['stop', '--timeout', '30', name], { timeoutMs: 60_000 });
  if (proc && proc.exitCode === null) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 45_000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export async function deleteVm(name: string): Promise<void> {
  await tryRun(config.tart, ['delete', name], { timeoutMs: 60_000 });
}

export async function stopAndDelete(name: string, proc?: ChildProcess): Promise<void> {
  await stopVm(name, proc);
  await deleteVm(name);
}
