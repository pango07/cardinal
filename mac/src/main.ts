#!/usr/bin/env node
// cardinal-mac: ephemeral macOS runners for GitHub Actions, on an Apple Silicon host.
//
//   cardinal-mac prepare [--force]            build the base VM (pulls the Xcode image, ~70 GB, once)
//   cardinal-mac run --repo owner/name [...]  poll those repos and run every `runs-on: cardinal-macos` job in its own VM
//   cardinal-mac sweep                        delete leftover job VMs
import { parseArgs } from 'node:util';
import { config, vmPrefix } from './config.ts';
import { sleep } from './exec.ts';
import { queuedJobs } from './github.ts';
import { runOneJob } from './job.ts';
import { log } from './log.ts';
import { prepare } from './prepare.ts';
import { listVms, stopAndDelete, vmExists } from './tart.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', multiple: true, default: [] },
    force: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
  },
});

const command = positionals[0];
switch (command) {
  case 'prepare':
    await prepare({ force: values.force });
    break;
  case 'sweep':
    await sweep();
    break;
  case 'run':
    await main();
    break;
  default:
    console.error('usage: cardinal-mac prepare [--force] | run --repo owner/name [--repo ...] [--once] | sweep');
    process.exit(64);
}

async function sweep(): Promise<void> {
  for (const vm of await listVms()) {
    if (!vm.name.startsWith(vmPrefix)) continue;
    log('sweep', `deleting ${vm.name}`);
    await stopAndDelete(vm.name);
  }
}

async function main(): Promise<void> {
  const repos = (values.repo.length ? values.repo : (process.env.CARDINAL_MAC_REPOS ?? '').split(',')).map((r) => r.trim()).filter(Boolean);
  if (!repos.length) throw new Error('pass --repo owner/name (or CARDINAL_MAC_REPOS)');
  if (!(await vmExists(config.baseVm))) throw new Error(`base VM ${config.baseVm} missing; run \`cardinal-mac prepare\` first`);
  await sweep();

  const active = new Map<number, Promise<void>>();
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    log('run', `stopping after ${active.size} active job(s); press again to force`);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log('run', `watching ${repos.join(', ')} for runs-on: ${config.label}`, { concurrency: config.concurrency, base: config.baseVm });
  while (!stopping) {
    if (active.size < config.concurrency) {
      for (const repo of repos) {
        let jobs;
        try {
          jobs = await queuedJobs(repo, config.label);
        } catch (err) {
          log('run', `poll failed for ${repo}: ${(err as Error).message}`);
          continue;
        }
        for (const job of jobs) {
          if (active.size >= config.concurrency || active.has(job.id)) continue;
          log('run', `dispatching job ${job.id} "${job.name}"`, { repo, queuedAt: job.created_at });
          const p = runOneJob(job)
            .catch((err) => log('run', `job ${job.id} failed: ${(err as Error).stack ?? err}`))
            .finally(() => active.delete(job.id));
          active.set(job.id, p);
        }
      }
    }
    if (values.once && active.size === 0) break;
    await sleep(config.pollMs);
  }
  await Promise.all(active.values());
}
