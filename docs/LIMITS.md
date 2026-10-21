# Limits

## No Docker

Vercel Sandbox is a Firecracker microVM and can't nest virtualization or run a Docker daemon. These fail:

- `container:` on a job
- `services:` (Postgres, Redis, … sidecars)
- Docker-based actions (`runs: using: docker`)
- `docker build` / `docker run` in a step

Most Node, Python, Go and Rust jobs never need Docker. For a database in tests, install it with apt in a step, or point at a hosted dev database.

## Job length

Max job length = sandbox timeout, `CARDINAL_TIMEOUT_MINUTES` (default 60). Pro allows up to 24h. When the timeout hits, the sandbox is killed and GitHub marks the job as failed after it loses the runner.

## Teardown paths

| Job length | Who stops the sandbox |
|---|---|
| Up to about 12.5 min | The webhook function that started it, right after the runner exits |
| Longer | The `workflow_job.completed` webhook (stops the sandbox by runner name) |
| Neither arrived | The runner's idle watchdog (no job within `CARDINAL_IDLE_TIMEOUT_SECONDS`, default 300), else the sandbox timeout |

Vercel Functions on Pro top out at `maxDuration = 800` s, so `waitUntil` cannot watch a 30-minute job. The sandbox runs detached either way. The function watches it for as long as it lives, then hands off.

## Concurrency

One job per sandbox, always. Concurrency is limited only by your Vercel plan (Pro: 10,000 concurrent sandboxes; the vCPU allocation rate ramps from 150/min).

## Platform

Linux amd64 on Vercel Sandbox. macOS arm64 through [`agent/`](../agent/README.md), on your own Apple Silicon hardware: at most 2 VMs per Mac, about 25 s boot, and the Mac has to be on. No Windows, no Linux arm64 yet.

## Runner ≠ job

GitHub JIT runners take *any* queued job whose labels match, not necessarily the one that triggered them. If two `cardinal` jobs queue together, runner `cardinal-101` may run job 102. Every job still gets exactly one sandbox, and teardown keys off the runner name that GitHub reports, so this is harmless. It does mean a sandbox name doesn't tell you which job it ran; use the job page's "Runner" field.

## Exit codes

The `exitCode` in the job summary log is the runner process's exit code, not the job's result. The runner exits 0 after a failed job too. GitHub is the source of truth for pass/fail.
