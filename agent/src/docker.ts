// Docker backend: one fresh container from the runner image per job. Not a VM, so weaker isolation than Tart or
// Sandbox, but it runs anywhere Docker does and needs no image build: the public Cardinal image is used by default.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config } from './config.ts';
import { tryRun } from './exec.ts';
import { log } from './log.ts';

export async function pullImage(): Promise<void> {
  log('docker', `pulling ${config.dockerImage}`);
  const out = await tryRun(config.docker, ['pull', '--quiet', config.dockerImage], { timeoutMs: 15 * 60_000 });
  if (out === null) throw new Error(`docker pull ${config.dockerImage} failed`);
}

/** Runs the runner in a container; resolves with the container's exit code. JIT config goes in via env. */
export function runContainer(name: string, jitConfig: string, onLine: (line: string) => void): { done: Promise<number>; kill: () => void } {
  const args = [
    'run', '--rm', '--name', name,
    '--cpus', String(config.cpu), '--memory', `${config.memoryMb}m`,
    '-e', 'CARDINAL_JIT_CONFIG', '-e', `CARDINAL_IDLE_TIMEOUT=${Math.round(config.idleTimeoutMs / 1000)}`,
    '--platform', 'linux/amd64',
    config.dockerImage, 'bash', '/home/runner/entrypoint.sh',
  ];
  const child = spawn(config.docker, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CARDINAL_JIT_CONFIG: jitConfig } });
  createInterface({ input: child.stdout }).on('line', onLine);
  createInterface({ input: child.stderr }).on('line', onLine);
  const done = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  return { done, kill: () => void tryRun(config.docker, ['stop', '-t', '20', name]) };
}

export async function removeContainers(prefix: string): Promise<string[]> {
  const out = await tryRun(config.docker, ['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}']);
  const names = (out ?? '').split('\n').filter(Boolean);
  for (const n of names) await tryRun(config.docker, ['rm', '-f', n]);
  return names;
}
