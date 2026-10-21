// Fixed CPU work for benchmarking runners. Usage: node cpu.mjs single|multi [iterations]
//   single: all iterations on one thread
//   multi:  the same total iterations split across every available core
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

function work(n) {
  let buf = Buffer.alloc(64, 1);
  for (let i = 0; i < n; i++) buf = createHash('sha256').update(buf).digest();
  return buf.toString('hex').slice(0, 8);
}

if (!isMainThread) {
  parentPort.postMessage(work(workerData));
} else {
  const mode = process.argv[2] ?? 'single';
  const total = Number(process.argv[3] ?? 8_000_000);
  const threads = mode === 'multi' ? availableParallelism() : 1;
  const t0 = performance.now();
  if (threads === 1) {
    work(total);
  } else {
    await Promise.all(
      Array.from({ length: threads }, () =>
        new Promise((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: Math.ceil(total / threads) });
          w.once('message', resolve).once('error', reject);
        }),
      ),
    );
  }
  const ms = Math.round(performance.now() - t0);
  console.log(`CARDINAL_BENCH ${JSON.stringify({ mode, threads, total, ms })}`);
}
