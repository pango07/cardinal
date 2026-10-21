import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function run(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { maxBuffer: 64 << 20, timeout: opts.timeoutMs });
  return stdout.trim();
}

/** Like run(), but resolves to null instead of throwing. */
export async function tryRun(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<string | null> {
  try {
    return await run(cmd, args, opts);
  } catch {
    return null;
  }
}

export function start(cmd: string, args: string[]): ChildProcess {
  return spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
