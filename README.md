<p align="center">
  <img src="assets/cardinal-logo.png" alt="Cardinal" width="520">
</p>

<p align="center"><strong>GitHub Actions runners that exist only while your job runs.</strong></p>

<p align="center">
  Change one line in a workflow. Each job boots a fresh microVM in about a second, runs, and is destroyed.<br>
  No runners to host, nothing idling, zero GitHub-hosted minutes.
</p>

```yaml
jobs:
  build:
    runs-on: cardinal      # that's the whole migration
```

---

## Why

Every GitHub Actions job runs on a machine you pay for one of three ways:

- **GitHub-hosted runners**: easy, metered by the minute, rounded up, and capped by free-minute quotas. When billing hiccups, CI stops.
- **Self-hosted VMs**: cheap per minute but always on, always patched by you, and idle most of the day.
- **Kubernetes runners (ARC) or EC2 autoscalers**: elastic, and also a second infrastructure project to own.

Cardinal is the fourth option: treat a runner like a function call. A `workflow_job.queued` webhook arrives, a microVM is created from a pre-baked image, the Actions runner inside claims **that one job**, runs it, exits, and the VM is gone. You pay for the seconds it ran. There is nothing to patch, scale, or wake up.

## How it works

```
   GitHub                    Cardinal dispatcher                Compute
   ──────                    (one Vercel Function)              ───────
   job queued ──webhook──►   verify signature
   runs-on: cardinal         mint a single-use runner token
                             create a microVM from the image ──►  boots (~0.7 s)
                             ◄── 202 OK (GitHub sees ~0.5 s)      runner starts, claims the job
                             watch it, stream logs                job runs
                             stop the VM when the runner exits    VM destroyed
```

Four properties fall out of that:

| | |
|---|---|
| **One job, one VM** | Every job gets a clean machine. No leftover state, no shared disk, no noisy neighbour. |
| **Single-use credentials** | Runners register with GitHub's JIT config: valid for one job, then they deregister themselves. Nothing to rotate or clean up. |
| **Pay for seconds** | Vercel Sandbox bills active CPU and memory per second. A 10-minute build on 2 vCPU costs about **2.5 ¢**. A queue that's empty all night costs nothing. |
| **Nothing to run** | The dispatcher is a Next.js route on Vercel. The images live in Vercel Container Registry. You never SSH into anything. |

Measured, not estimated: GitHub queue → runner listening in **3 s**, sandbox create in **0.6–1.0 s**, teardown within **1 s** of the runner exiting, and a `next build` job that runs **24% faster** than on GitHub's 4 vCPU runner ([benchmarks](bench/RESULTS.md)).

## Three things no other runner does

**Jobs start where the last green one ended.** Every job runs on a fork of the filesystem left by the last successful run of *that job* on your default branch, about a second after it's queued. `node_modules`, `~/.gradle`, `~/.npm`, the tool cache: already there. No cache action, no cache keys, no upload at the end of the job (which is also where most of the egress bill went). Measured on the same job, back to back: `npm install` 12 s → 3 s, job 20 s → 7 s. Add `clean: false` to `actions/checkout` to keep in-workspace files like `node_modules`; home-directory caches carry over regardless. Set `CARDINAL_WARM=0` to turn it off.

**Open a failed job as a live machine.** Failed jobs are kept for 7 days. `npm run open -- <job url>` forks the exact filesystem the job died in, in about 1.5 s, and drops you into a shell: the workspace, the half-written build output, the environment the job saw (credentials and runner temp are scrubbed first). The original is untouched, so two people can open the same failure. Green jobs on other branches are deleted; green jobs on the default branch become the next warm base.

**Runners boot before GitHub asks.** On every push, Cardinal boots a runner for each job that branch ran last time, so when GitHub queues the jobs a few seconds later they're picked up by runners that are already listening. Wrong guesses idle out after 90 s for a fraction of a cent. A once-a-minute sweep re-dispatches anything that fell through and removes dead runners. (Needs the App's *Contents: read* permission for the `push` event; setup explains.)

## What runs on it

| Workload | Label | What's in the box |
|---|---|---|
| Node, Python, Go, Rust, anything `apt` can install | `cardinal` · `cardinal-4x` · `cardinal-8x` | Ubuntu 24.04, Node 22, git, jq. 2 / 4 / 8 vCPU with 2 GB per vCPU |
| **Android** | `cardinal-android` | Everything above plus Temurin JDK 21 and the Android SDK (API 36/37, build-tools 36.1). 8 vCPU / 16 GB. No `setup-java`, no license step |
| **macOS, iOS, Xcode** | `cardinal-macos` | macOS 26 with Xcode 26.4.1 and iOS simulators, in a fresh Tart VM on an Apple Silicon host you own. See [mac/](mac/) |

Everything in that table is verified on real projects: a Turborepo monorepo typecheck + test, a full Android app build with lint and 721 Robolectric tests (~4.5 min), 178 Roborazzi screenshot comparisons, and `xcodebuild test` on iPhone and iPad simulators.

## Get running

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fpango07%2Fcardinal&root-directory=dispatcher&project-name=cardinal&repository-name=cardinal)

Five minutes, on a Vercel Pro account:

1. **Deploy** with the button (it clones this repo and deploys `dispatcher/`). The runner images are public, so there's nothing to build.
2. Open **`https://<your-deployment>/setup`** and click *Create the GitHub App*. GitHub creates the App with the right permissions and webhook; the next page shows three values.
3. Paste them as Production env vars (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`) and redeploy.
4. Install the App on a repo, put `runs-on: cardinal` in a workflow, push.

Prefer your own images, a CLI-only flow, or want macOS? [docs/SETUP.md](docs/SETUP.md).

## Speed

Five rounds against GitHub's 4 vCPU `ubuntu-latest`, medians in seconds ([full results](bench/RESULTS.md)):

| Job | `ubuntu-latest` | `cardinal-4x` | `cardinal` (2 vCPU) |
|---|---|---|---|
| `create-next-app` + `next build` | 41 | **31** | 44 |
| clone + `npm install` + `npm test` (express) | 17 | **13** | 20 |
| Pure CPU (sha256, single + multi-thread) | **18** | 24 | 28 |
| Queue → job started | **1** | 4 | 4 |

Install- and build-heavy jobs win on Cardinal (fast network, fast boot). Per-thread CPU is about 60% slower, and pickup adds ~3 s per job. For most CI that trade is a net win; for a single-threaded compile-only job it isn't.

## Cost

Vercel Sandbox, iad1, Pro rates: $0.128 per active-CPU-hour, $0.0212 per GB-hour of memory, **$0.15 per GB of egress**, nothing for ingress. Active CPU counts only while the CPU is busy, so waiting on downloads is nearly free. Egress is mostly `actions/cache`-style uploads back to GitHub; the dispatcher itself costs about a cent a day.

Measured on a real day of use (88 jobs, including ten full Android builds and 45 benchmark runs): **$2.23**, about 2.5 ¢ per job. The honest comparison:

| Job | GitHub-hosted (private repo) | Cardinal |
|---|---|---|
| 30 s test run | $0.008 (rounded up to a minute) | **~$0.002** |
| 10 min, 2 vCPU, 50% busy | $0.08 | **~$0.025** |
| 7 min Android build, 8 vCPU, cache upload | $0.16 (8-core larger runner) | ~$0.12 |
| An empty queue, all month | $0 | $0 |

Short and bursty jobs are several times cheaper. Long, CPU-bound jobs on big VMs cost about the same as GitHub's larger runners, because a busy CPU-second costs what it costs. What you don't pay for is idle time, minute rounding, or the queue.

Usage comes out of the Pro plan's $20/month credit first.

## How it compares

| | Cardinal | GitHub-hosted | Self-hosted VM | ARC (Kubernetes) | RunsOn / EC2 autoscalers | Hosted fast runners (Depot, Blacksmith, …) | Vercel Daemons |
|---|---|---|---|---|---|---|---|
| Infra you operate | none | none | a VM | a cluster | a VPC + Lambda/ASG | none | none |
| Idle cost | **$0** | $0 | always on | cluster | ~$0 | $0 | always on |
| Fresh VM per job | **yes** | yes | no | pod | yes | yes | no |
| Setup | ~30 min | 0 | hours | days | hours | minutes | minutes |
| macOS | your Mac, 2 VMs | yes | if you own one | no | yes (mac instances, 24 h min) | some | no |
| Price basis | per second | per minute, rounded up | per hour | per node | per second-ish | per minute | per second |

Cardinal is not a new idea; ephemeral-VM-per-job is what RunsOn and the hosted services do. It's the version with nothing to host, on a compute primitive that boots in a second and bills by the second. If you want zero-latency pickup for a handful of steady jobs, a warm pool (Daemons) is a better fit. If your CI is bursty and idle most of the day, per-job sandboxes are cheaper and cleaner.

## Limits

- **No Docker inside jobs.** The sandbox is a microVM without nested virtualization. `container:`, `services:` and Docker-based actions don't work. Most Node/Python/Go/Rust/Android jobs never need it.
- **Job length** is capped by the sandbox timeout: 60 min by default, up to 24 h on Pro.
- **Concurrency** is your Vercel plan's sandbox quota (Pro: 10,000).
- **macOS needs a Mac.** Apple only lets macOS run on Apple hardware, so `cardinal-macos` uses a small agent on your own Apple Silicon machine (laptop, Mac mini, or rented), two VMs at a time.
- **Linux is amd64 only** for now.
- **Public repos:** don't let fork pull requests run on your compute. See [SECURITY.md](SECURITY.md).

Details in [docs/LIMITS.md](docs/LIMITS.md).

## What's in the repo

```
image/        Dockerfile for the runner images (base + android stage), push script
dispatcher/   Next.js app on Vercel: the webhook, GitHub App auth, the Vercel Sandbox driver
mac/          cardinal-mac: the macOS driver (Tart VMs on Apple Silicon)
bench/        benchmark workflow, CPU workload, results collector, RESULTS.md
docs/         SETUP.md, LIMITS.md, FINDINGS.md (every measurement and gotcha so far)
examples/     a workflow that runs on: cardinal
```

The driver interface is ~20 lines ([dispatcher/lib/drivers/types.ts](dispatcher/lib/drivers/types.ts)): boot compute from the image, run one job, tear down. Fargate, Fly, Hetzner or anything else with an API can slot in without touching the webhook.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Measurements are especially welcome: [docs/FINDINGS.md](docs/FINDINGS.md) lists what's been measured and what hasn't (arm64, snapshot boots, drive-backed caches).

## License

[MIT](LICENSE)
