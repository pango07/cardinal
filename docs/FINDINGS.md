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

## Other measurements

- **Image size: 378 MB** (`docker image inspect`, linux/amd64, actions/runner 2.338.0, Node 22.23). Target was < 600 MB.
- Runner version and libraries verified in-container: `Runner.Listener --version` works and `.NET` loads ICU/OpenSSL.

## Deviations from the brief

- **`vercel vcr build` / `vcr push` are documented but missing** from Vercel CLI 56.4. `image/push.sh` uses `vercel vcr login docker` + `docker buildx build --push` to `vcr.vercel.com/<team-slug>/<project>/cardinal-runner`, which works with any CLI version.
- **Sandbox `resources` takes only `vcpus`.** Memory is fixed at 2048 MB/vCPU by the platform. `memoryMb` stays in `RunnerSize` for cost estimates only.
- **`persistent: false`** on create. Sandbox SDK v3 defaults to persistent, which would snapshot every runner's filesystem on stop.
- **Driver interface** gained `stop(runnerName)` and `RunOneJobResult.handedOff`, needed for the long-job path in Q2.
- **Label matching is exact** (`cardinal`, `cardinal-4x`, `cardinal-8x`), not `startsWith('cardinal')`. This way a job labelled `cardinal-foo` isn't silently run at the default size.
- **No `sudo: true` on `runCommand`.** Verified on a live sandbox: commands run as the image's `USER` (`runner`, uid 1000), and `sudo` strips the command `env`, which would drop the JIT config. The entrypoint also adds the VM hostname to `/etc/hosts`, because otherwise every `sudo` in a job warns "unable to resolve host".
- **Idle watchdog** in `entrypoint.sh`. A JIT runner takes any matching queued job, so if its triggering job was cancelled first it would idle until the sandbox timeout. It now exits after `CARDINAL_IDLE_TIMEOUT_SECONDS` (300) with no job.
- `ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT` removed. It dumps the full runner trace (hundreds of lines) into the logs.
