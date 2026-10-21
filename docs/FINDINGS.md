# Findings: open questions from the brief

Status as of 2026-10-20 (actions/runner 2.338.0, @vercel/sandbox 3.8.0). "Measured" means run locally. "Pending" needs a live Vercel project and GitHub App; run `npm run smoke` (see SETUP.md) and fill these in.

| # | Question | Status | Answer |
|---|---|---|---|
| 1 | Cold boot: `Sandbox.create()` → "Listening for Jobs" (target < 10 s) | Measured | **3.07 s**: 1.26 s `Sandbox.create` + 1.81 s runner start (iad1, 2 vCPU, 378 MB image). A second create took 1.29 s. The runner picked up the already-queued job within 1 s of listening; `hello-cardinal` finished in 8 s using 15 s of active CPU |
| 2 | Does `waitUntil` + `maxDuration` cover a 30-min job? | Answered from limits | **No.** The Pro function ceiling is 800 s. The runner runs `detached: true`. The function watches until about 30 s before its deadline, then hands off. `workflow_job.completed` stops the sandbox by runner name, and the sandbox timeout is the last line of defense |
| 3 | `vercel/sandbox/ubuntu` vs `ubuntu:24.04` | Pending | Note: `vercel/sandbox/ubuntu` is now **26.04**. actions/runner's dependency script knows libicu up to 80, but 26.04 support isn't confirmed. Stay on 24.04 until measured |
| 4 | Does `installdependencies.sh` pull anything we miss? | Measured | **No.** On 24.04 it installs exactly `libkrb5-3 zlib1g liblttng-ust1t64 libssl3t64 libicu74`, which are all in our apt list. (The brief's `libssl3`/`liblttng-ust1` names are pre-t64; 24.04 renamed them.) `ldd` reports `liblttng-ust.so.0` missing for .NET's optional trace provider; that's expected, harmless, and identical with installdependencies.sh |
| 5 | arm64 runner in an arm64 sandbox | Not started | Phase 3 |
| 6 | Snapshot boot vs image boot | Not started | Phase 3 |

## Phase 2 acceptance (live, 2026-10-20)

Production dispatcher on Vercel Pro (iad1), image `cardinal-runner:v0.3`, repo `pango07/cardinal-test`.

| Check | Result |
|---|---|
| Push / dispatch → queued → in progress → success, no human action | ✅ `hello-cardinal` green in 18 s end to end |
| Webhook responds < 2 s | ✅ ~0.55 s round trip (the slow work runs in `waitUntil` after the 202) |
| Sandbox stopped ≤ 30 s after job completion | ✅ ~1 s: the dispatcher stops it as soon as the runner exits; the later `completed` webhook finds it already stopped |
| Concurrent jobs get their own sandboxes | ✅ 4 jobs dispatched together → 4 sandboxes, 2 of them running 30 s side by side |
| Failed job (exit 1) tears down cleanly | ✅ job marked failed, sandbox stopped 5 s after creation |
| `cardinal-4x` sizing | ✅ `nproc` = 4, 8 GB RAM |

From the per-job summaries (6 jobs): Sandbox.create **640–1003 ms**, queue → sandbox up **3.1–3.8 s** (one outlier at 7.3 s, when 4 jobs queued at once), estimated cost **$0.0016–0.003 per job**.

## Speed vs GitHub-hosted

See [bench/RESULTS.md](../bench/RESULTS.md). `cardinal-4x` beats a 4 vCPU `ubuntu-latest` by about 24% on `next build` and on npm install + test. It loses about 60% per thread on pure CPU work, and pickup takes about 3 s longer.

## Snapshots and forks (2026-10-21, live)

| Operation | Measured |
|---|---|
| `sandbox.snapshot()` of a 607 MB filesystem (11k files) | 2.1 s |
| `Sandbox.create({ source: snapshot })`, files immediately usable | 1.4 s |
| Three parallel creates from one snapshot | 1.35 s total |
| `Sandbox.fork()` of a stopped persistent sandbox | 1.36 s |
| Warm-started job vs cold (same `npm install next` job) | boot 1.0 s vs 0.8 s; install 3 s vs 12 s; job 7 s vs 20 s |
| `open` a failed job (fork + ready) | 1.6 s |

Snapshot storage is $0.08/GB-month (15 GB included on Pro). Every job sandbox is persistent; the `completed` webhook decides: green on default branch → warm base for (repo, job name), replacing the previous; green elsewhere → deleted; failed → kept 7 days. State is sandbox tags (`warm`, `role`, `img`); no database. A base is only reused when its `img` tag matches the image we'd boot today, so image upgrades start a new lineage.

Caveat: `actions/checkout` runs `git clean -ffdx` by default, which deletes ignored files such as `node_modules`. Workflows that want in-workspace reuse set `clean: false`. Home caches (`~/.npm`, `~/.gradle`, `_work/_tool`) survive either way.

## Other measurements

- **Image size: 378 MB** (`docker image inspect`, linux/amd64, actions/runner 2.338.0, Node 22.23). Target was < 600 MB.
- Runner version and libraries verified in-container: `Runner.Listener --version` works and `.NET` loads ICU/OpenSSL.

## Beyond the brief

- **`cardinal-android`**: a second Dockerfile stage (`image/Dockerfile`, `--target android`) with Temurin JDK 21 and the Android SDK. Jobs find them through the runner's own `.env`/`.path` files, since Sandbox doesn't apply Docker `ENV`. Selected per label via `RunnerSize.image`.
- **macOS driver** (`mac/`): the brief's phase 2. Vercel has no macOS compute, so it's a polling agent on an Apple Silicon Mac that clones a Tart VM per job from a cirruslabs Xcode image, runs the runner over SSH with the JIT config on stdin, and deletes the VM. Two VMs per host is Apple's limit.

## Deviations from the brief

- **`vercel vcr build` / `vcr push` are documented but missing** from Vercel CLI 56.4. `image/push.sh` uses `vercel vcr login docker` + `docker buildx build --push` to `vcr.vercel.com/<team-slug>/<project>/cardinal-runner`, which works with any CLI version.
- **Sandbox `resources` takes only `vcpus`.** Memory is fixed at 2048 MB/vCPU by the platform. `memoryMb` stays in `RunnerSize` for cost estimates only.
- **`persistent: false`** on create. Sandbox SDK v3 defaults to persistent, which would snapshot every runner's filesystem on stop.
- **Driver interface** gained `stop(runnerName)` and `RunOneJobResult.handedOff`, needed for the long-job path in Q2.
- **Label matching is exact** (`cardinal`, `cardinal-4x`, `cardinal-8x`), not `startsWith('cardinal')`. This way a job labelled `cardinal-foo` isn't silently run at the default size.
- **No `sudo: true` on `runCommand`.** Verified on a live sandbox: commands run as the image's `USER` (`runner`, uid 1000), and `sudo` strips the command `env`, which would drop the JIT config. The entrypoint also adds the VM hostname to `/etc/hosts`, because otherwise every `sudo` in a job warns "unable to resolve host".
- **Idle watchdog** in `entrypoint.sh`. A JIT runner takes any matching queued job, so if its triggering job was cancelled first it would idle until the sandbox timeout. It now exits after `CARDINAL_IDLE_TIMEOUT_SECONDS` (300) with no job.
- `ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT` removed. It dumps the full runner trace (hundreds of lines) into the logs.
