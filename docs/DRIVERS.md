# Writing a driver

A driver is how Cardinal turns "run this job" into compute somewhere. The webhook, GitHub App, labels, pre-boot and sweep never change; a driver only has to boot a machine from the runner image, run the entrypoint with one environment variable, and tear the machine down. The Vercel Sandbox driver is ~150 lines; the macOS one (`agent/`) is the same idea against Tart VMs.

Good candidates: Fly Machines, AWS Fargate, Hetzner Cloud, Modal, E2B, Northflank, a homelab Proxmox, anything with an API that can start a container or VM from an image in a few seconds.

## The interface

[`dispatcher/lib/drivers/types.ts`](../dispatcher/lib/drivers/types.ts):

```ts
interface RunnerDriver {
  readonly name: string;
  runOneJob(input: RunOneJobInput): Promise<RunOneJobResult>;
  stop(runnerName: string): Promise<boolean>;
  snapshots?: SnapshotOps;          // optional: warm starts and keep-on-failure
}
```

### `runOneJob`

1. Boot compute from the runner image (`CARDINAL_IMAGE`, or `input.size.image` for label-specific images) with `input.size.vcpus` and a hard timeout of `input.size.timeoutMs`. Name it `input.runnerName`; that name is how `stop` finds it later.
2. Run `bash /home/runner/entrypoint.sh` as the image's user with environment `CARDINAL_JIT_CONFIG=<await input.jitConfig>` and `CARDINAL_IDLE_TIMEOUT=<input.idleTimeoutSec>`. `jitConfig` is a promise so you can start booting before the token exists. Never log it or put it on a command line.
3. Stream the process output to your logs (prefix it with the runner name).
4. Wait for the process to exit, tear the compute down, and resolve with the exit code, boot time and duration. If you can measure active CPU, return it: it feeds the cost line.
5. If the process is still running when `input.watchMs` has elapsed, **leave it running** and resolve with `handedOff: true`. Cardinal's `workflow_job.completed` webhook will call `stop(runnerName)`; your timeout from step 1 is the backstop.

### `stop`

Tear down the compute named `runnerName`. Return `false` if nothing was running. Must be safe to call twice and for names that never existed.

### `snapshots` (optional)

Implement this if your platform can snapshot a machine's filesystem and start a new machine from it. With it, Cardinal forks every job from the last green run of that job (see the README), keeps failed jobs for `open`, and prunes the rest. You need:

- `listTagged(key, value)`: machines carrying that tag, newest first, with their tags and whether they're stopped.
- `setTags(name, tags)`: merge tags onto a machine.
- `remove(name)`: delete the machine and its snapshots. Idempotent.

And `runOneJob` must honour `input.persist`: keep the filesystem when the runner exits (so the machine can be forked later), and when `persist.forkFrom` is set, start from that machine's snapshot instead of the image. If forking fails, fall back to a cold boot; never fail the job for a missing base.

## What the entrypoint expects

- The image's `entrypoint.sh` is at `/home/runner/entrypoint.sh` and must run as the `runner` user (uid 1000, passwordless sudo). It starts `actions/runner` with the JIT config, waits for a job, runs it, exits.
- Outbound network to `github.com`, `api.github.com`, `*.actions.githubusercontent.com` and package registries. No inbound needed.
- 2 GB of memory per vCPU is the assumption behind the size table; adjust `config.ts` if your platform differs.

## Contract test

`dispatcher/test/driver-contract.test.ts` runs your driver against real compute with an invalid JIT config: the runner must start, reject the config, exit non-zero, and the compute must be gone afterwards. It checks boot time, teardown, and that `stop` on a stale name is harmless.

```bash
cd dispatcher
CARDINAL_DRIVER=fly CARDINAL_IMAGE=... npm run driver-test
```

Register your driver in `lib/drivers/index.ts` under a name, and select it with `CARDINAL_DRIVER`.

## Checklist for a PR

- [ ] Boots from the runner image, not a hand-maintained VM.
- [ ] Teardown in `finally`; nothing leaks when the runner crashes or the job is cancelled.
- [ ] `stop` is idempotent.
- [ ] Hand-off works for jobs longer than the webhook function can watch.
- [ ] Contract test passes; include its timings in the PR.
- [ ] A section in `docs/SETUP.md` for the credentials your platform needs.
