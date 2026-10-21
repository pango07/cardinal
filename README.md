# Cardinal

**Bring-your-own-compute GitHub Actions runners. Ephemeral, billed per second, zero GitHub minutes.**

A job is queued, a Firecracker microVM boots from a pre-baked image, the runner inside claims one job, runs it and exits, and the VM is destroyed. You pay for the seconds the job ran. Nothing sits idle.

```yaml
jobs:
  build:
    runs-on: cardinal        # cardinal-4x, cardinal-8x for more vCPUs
```

The first compute target is [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox). Others plug in as drivers.

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

## Sizes

| Label | vCPU | Memory |
|---|---|---|
| `cardinal` | 2 | 4 GB |
| `cardinal-4x` | 4 | 8 GB |
| `cardinal-8x` | 8 | 16 GB |

## Known limits

- **No Docker.** There's no nested virtualization in the sandbox. `container:`, `services:` and Docker-based actions fail. Most Node, Python, Go and Rust jobs never need Docker.
- **Max job length** = sandbox timeout. 60 min by default; Pro allows 24h.
- **Concurrency** = your Vercel plan quota (Pro: 10,000 sandboxes; the vCPU allocation rate ramps from 150/min).
- **Linux amd64 only** in v1.
- **Public repos:** don't let fork PRs run on Cardinal; it's your compute. See [SECURITY.md](SECURITY.md).

Details: [docs/LIMITS.md](docs/LIMITS.md).

## Cost

At iad1 Pro rates, a 10-minute job on 2 vCPU / 4 GB at 50% CPU costs about **$0.025**: $0.011 active CPU plus $0.014 memory. GitHub charges $0.08 for the same 10 minutes once you're past free minutes. Active CPU only bills while the CPU is actually busy, so time spent waiting on `npm install` downloads is nearly free. Ingress is free. Each job logs its own estimate.

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
