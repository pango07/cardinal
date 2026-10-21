# Roadmap

What's shipped, what's next, and the design for the hosted version. Dates are when things landed.

## Shipped

| | | Landed |
|---|---|---|
| Linux runners on Vercel Sandbox (`cardinal`, `-4x`, `-8x`) | 3 s queue→running, per-second billing | 2026-10-20 |
| Android image (`cardinal-android`) | JDK 21 + SDK baked in | 2026-10-21 |
| macOS via Tart on your own Apple Silicon (`cardinal-macos`) | Xcode 26.4.1, simulators, Roborazzi verified | 2026-10-21 |
| Pre-boot on push | runners listening before GitHub queues the jobs | 2026-10-21 |
| Minute sweep | lost-webhook safety net, dead-runner cleanup | 2026-10-21 |
| Warm starts | every job forks the last green run of that job (20 s → 7 s) | 2026-10-21 |
| `open` | fork a failed job's filesystem into a live shell in 1.6 s | 2026-10-21 |
| One-click install | Deploy button + hosted `/setup`, public images | 2026-10-21 |
| Driver guide + contract test | add a compute backend in ~150 lines | 2026-10-21 |
| Agent with Docker backend | `cardinal-docker`: any machine with Docker takes jobs | 2026-10-21 |

## Next

1. **Install once, fork into shards.** For `strategy.matrix` jobs that share a setup (checkout + install), run the setup once and fork the VM N ways in ~1.4 s each. Needs: detect matrix siblings in the `push` pre-boot (same job name prefix, same labels), run the first to the end of its install steps, snapshot, fork. The runner has no "pause after step k" hook, so the practical version is: the *first* shard's green run becomes the base and the other shards fork it on the *next* push. That already follows from warm starts; the per-push fork is the upgrade.
2. **`cardinal join` for teams.** The agent already runs Tart (macOS) and Docker. Missing: a `join` subcommand that registers the machine with a hosted dispatcher instead of polling GitHub itself, idle/AC-power detection, and a `linux-firecracker` backend (Firecracker + KVM) for real VM isolation on Linux hosts.
3. **Receipts.** Per-job cost as a check annotation, and a README badge "CI cost this month: $x". The dispatcher already logs the number.
4. **Micro-runner.** actions/runner is 150 MB of .NET that takes 1.8 s to start. A Go/Rust implementation of just the job protocol (there's prior art in `github-act-runner`) would cut the image to ~30 MB and boot-to-listening to well under a second.
5. **arm64 Linux**, snapshot-vs-image boot comparison, drive-backed shared caches: measurements the brief asked for and nobody has taken yet.

## Cardinal Cloud (hosted dispatcher)

The question: could Cardinal host the webhook and dispatcher for everyone, while each user's jobs run on *their* Vercel account?

**Why it works.** The dispatcher is stateless and costs about a cent a day per tenant. The expensive part, compute, is billed to the user's own Vercel project because the Sandbox SDK accepts explicit credentials (`token`, `teamId`, `projectId`). The images are public. So a hosted Cardinal pays for webhooks and nothing else.

**What a user does.** Install one GitHub App (ours, `cardinal-runner`) on their repos, then connect a Vercel project. Nothing to deploy.

**What we'd hold.** A GitHub installation id → Vercel credential mapping. That's the whole design problem: custody of a token that can spend someone else's money.

- Obtain it through a **Vercel Marketplace integration** (OAuth-style install that grants a project-scoped token), not copy-paste.
- Store it encrypted (Vercel KMS or a KMS-wrapped key in Neon/Upstash), decrypt per request, never log it.
- Per-tenant limits: max concurrent sandboxes, max job minutes per day, kill switch per installation.
- A status page and an audit log of every sandbox created, by whom, for which job.
- Self-host stays first-class; Cloud is the convenience, not the product.

**Build order.** Integration + connect page → tenant store → dispatcher reads credentials per installation → limits and audit → beta with a few repos. Roughly two weeks of work; none of it changes the runner image or the drivers.

**What it doesn't change.** macOS. A hosted dispatcher can't run Xcode anywhere; `cardinal-macos` stays an agent on Apple hardware the user owns or rents.
