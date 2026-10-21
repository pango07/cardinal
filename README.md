# Cardinal

**Bring-your-own-compute GitHub Actions runners. Ephemeral, billed per second, zero GitHub minutes.**

A job is queued, a Firecracker microVM boots from a pre-baked image, the runner inside claims one job, runs it and exits, and the VM is destroyed. You pay for the seconds the job ran. Nothing sits idle.

```yaml
jobs:
  build:
    runs-on: cardinal        # cardinal-4x, cardinal-8x for more vCPUs
```

Linux jobs run on [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVMs. macOS jobs (iOS builds, Xcode tests) run on ephemeral [Tart](https://github.com/cirruslabs/tart) VMs on an Apple Silicon Mac you own, via [`mac/`](mac/). Other targets plug in as drivers.

## How it works

```
GitHub                        Vercel Function (/api/webhook)          Vercel Sandbox
workflow_job.queued  ───────► verify HMAC, label ∈ {cardinal, …}
                              202 to GitHub, then in waitUntil:
                                generate-jitconfig (GitHub App) ───►
                                Sandbox.create(cardinal-runner) ────► microVM boots
                                runCommand(entrypoint.sh, detached) ► runner claims one job, runs it, exits
                                watch until exit (≤ ~12.5 min) ──────  sandbox.stop()
workflow_job.completed ─────► stop sandbox by runner name ─────────► (long jobs)
```

- [`image/`](image/): Ubuntu 24.04, actions/runner (SHA-verified), Node 22. About 380 MB.
- [`dispatcher/`](dispatcher/): Next.js app on Vercel. One webhook route and one driver.
- [`dispatcher/lib/drivers/`](dispatcher/lib/drivers/): the `RunnerDriver` interface and the Vercel Sandbox driver.

Runners register with **JIT configs**: single-use, and they deregister themselves. Auth is a **GitHub App**, not a PAT.

## Labels

| Label | Where | vCPU | Memory | Extras |
|---|---|---|---|---|
| `cardinal` | Vercel Sandbox | 2 | 4 GB | Ubuntu 24.04, Node 22, git, jq |
| `cardinal-4x` | Vercel Sandbox | 4 | 8 GB | same |
| `cardinal-8x` | Vercel Sandbox | 8 | 16 GB | same |
| `cardinal-android` | Vercel Sandbox | 8 | 16 GB | + JDK 21, Android SDK (API 36/37, build-tools 36.1) |
| `cardinal-macos` | Tart VM on your Mac | 8 | 16 GB | macOS 26, Xcode 26.4.1, simulators, + JDK 21, Android SDK |

## Known limits

- **No Docker.** There's no nested virtualization in the sandbox. `container:`, `services:` and Docker-based actions fail. Most Node, Python, Go and Rust jobs never need Docker.
- **Max job length** = sandbox timeout. 60 min by default; Pro allows 24h.
- **Concurrency** = your Vercel plan quota (Pro: 10,000 sandboxes; the vCPU allocation rate ramps from 150/min).
- **macOS needs a Mac.** `cardinal-macos` jobs run on your own Apple Silicon machine (2 VMs at a time per Mac). See [mac/README.md](mac/README.md).
- **Public repos:** don't let fork PRs run on Cardinal; it's your compute. See [SECURITY.md](SECURITY.md).

Details: [docs/LIMITS.md](docs/LIMITS.md).

## Cost

At iad1 Pro rates, a 10-minute job on 2 vCPU / 4 GB at 50% CPU costs about **$0.025**: $0.011 active CPU plus $0.014 memory. GitHub charges $0.08 for the same 10 minutes once you're past free minutes. Active CPU only bills while the CPU is actually busy, so time spent waiting on `npm install` downloads is nearly free. Ingress is free. Each job logs its own estimate.

## Speed

Against a 4 vCPU GitHub-hosted runner ([full results](bench/RESULTS.md), 5 rounds, medians):

| Job | `ubuntu-latest` | `cardinal-4x` |
|---|---|---|
| `create-next-app` + `next build` | 41 s | **31 s** |
| clone + `npm install` + `npm test` (express) | 17 s | **13 s** |
| Pure CPU (sha256, single + multi-thread) | **18 s** | 24 s |

Install- and network-heavy jobs run faster. Per-thread CPU is about 60% slower, and pickup adds about 3 s per job.

## Why not Vercel Daemons?

[Vercel Daemons](https://vercel.com/docs/daemons) (public beta) run a fixed number of always-on container instances, and the docs list "self-hosted CI runners" as a use case. It's a good fit for a small, steady pool. Cardinal makes a different trade-off:

| | Daemons (beta) | Cardinal (Sandbox) |
|---|---|---|
| Idle cost | Instances run 24/7. You pay provisioned memory around the clock | **Nothing runs between jobs.** Memory bills only while a job runs |
| Burst | Fixed instance count, no autoscaling. Pro quota: 16 vCPUs running at once (8 two-vCPU runners) | One sandbox per queued job, up to the plan's sandbox quota (Pro: 10,000) |
| Biggest machine | 4 vCPU / 8 GB | 8 vCPU / 16 GB on Pro (32 vCPU on Enterprise) |
| Isolation between jobs | Instances restart in place; disk is ephemeral, but jobs share an instance's lifetime | **Fresh Firecracker microVM per job**, destroyed afterwards |
| Pickup latency | ~0: the runner is already listening | ~3–4 s from queue to running (measured) |
| Job length | Unbounded | Sandbox timeout (Pro: 24h) |

If you want zero-latency pickup for a handful of steady jobs, a Daemons-backed warm pool is a reasonable future driver. For bursty CI that sits idle most of the day, per-job sandboxes are cheaper and isolate better.

## Get started

[docs/SETUP.md](docs/SETUP.md): Vercel project, image push, GitHub App, deploy, first green job.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Measurements for the open questions in [docs/FINDINGS.md](docs/FINDINGS.md) are especially welcome.

## Develop

```bash
cd dispatcher
npm install
npm test            # unit tests
npm run typecheck
npm run smoke -- --repo you/repo   # boot one real sandbox with a JIT config (see SETUP.md)
```

## License

[MIT](LICENSE)
