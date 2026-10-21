# Benchmark: Cardinal vs GitHub-hosted runners

Run on 2026-10-20 in [`pango07/cardinal-bench`](https://github.com/pango07/cardinal-bench), a public repo, with [`benchmark.yml`](benchmark.yml), 5 rounds run one after another. Medians, in seconds. Step and job times come from the GitHub API, which has 1 s resolution; the CPU columns are timed inside the job.

| Runner | Hardware |
|---|---|
| `ubuntu-latest` (public repo) | 4 vCPU, 16 GB, GitHub image `ubuntu-24.04` 20261012 |
| `cardinal-4x` | 4 vCPU (2 cores × 2 threads, Intel Xeon @ 2.9 GHz, KVM), 8 GB |
| `cardinal` | 2 vCPU, 4 GB |

All three ran Node v22.23.3. GitHub gives **private** repos a 2 vCPU / 8 GB `ubuntu-latest`. We couldn't run that one: the test account has no paid minutes. Plain `cardinal` is the like-for-like comparison for it.

## Results

| Workload | `ubuntu-latest` (4 vCPU) | `cardinal-4x` | `cardinal` (2 vCPU) |
|---|---|---|---|
| Queue → job started | **1** | 4 | 4 |
| CPU, single thread (10M sha256) | **10.0** | 16.5 | 16.0 |
| CPU, all cores (same total work) | **5.4** | 6.2 | 9.8 |
| `express` clone + `npm install` + `npm test` | 14 | **11** | 18 |
| `create-next-app` + `next build` | 39 | **29** | 42 |
| **Job total**: cpu | **18** | 24 | 28 |
| **Job total**: express-test | 17 | **13** | 20 |
| **Job total**: next-build | 41 | **31** | 44 |

All 45 jobs succeeded.

## What it says

- **Real-world jobs are faster on `cardinal-4x`**: 24% faster on a Next.js build and 24% faster on install + test than a 4 vCPU GitHub-hosted runner. These jobs are dominated by package downloads and many short processes, and the sandbox wins on both.
- **Raw per-thread CPU is slower.** A single thread takes about 60% longer on a Sandbox vCPU (16 s vs 10 s). A pure compute job (compiling, heavy tests on one core) will be slower than on GitHub-hosted. With all cores busy the gap narrows to about 15% at 4 vCPU.
- **Pickup takes about 3 s longer.** GitHub-hosted jobs in this public repo started within 1–2 s. Cardinal takes 3–4 s: webhook delivery, then minting the JIT config, then a ~0.6 s sandbox boot, then the runner connecting. That's fixed overhead per job, irrelevant for minute-long jobs and noticeable for 10-second ones.
- **`cardinal` (2 vCPU) roughly matches a 4 vCPU hosted runner on `next build`** (42 vs 39 s). Expect it to beat the 2 vCPU runner that private repos get.

## Cost

| | Per job here | Billing |
|---|---|---|
| `ubuntu-latest`, public repo | $0 | Free for public repos |
| `ubuntu-latest`, private repo (2 vCPU) | $0.008 | $0.008/min, rounded **up** to whole minutes |
| GitHub larger runner, 4 vCPU | $0.016 | $0.016/min, rounded up |
| `cardinal` | ~$0.003 | Active CPU + memory per second (1-min memory minimum) |
| `cardinal-4x` | ~$0.004 | Same |

Cardinal costs are the dispatcher's own `estCostUsd` estimates for a sample of these benchmark jobs (average ~25–38 s, ~40 s of active CPU). They come out of the Vercel Pro plan's $20 monthly credit first.

## Reproduce

1. Install the Cardinal App on a repo and copy `bench/benchmark.yml` into its `.github/workflows/`.
2. Dispatch it a few times: `gh workflow run benchmark.yml -R you/repo`
3. Summarize: `node bench/collect.ts --repo you/repo --runs 5`

Measure on a private repo too if you can: that's where GitHub-hosted runners cost money and have only 2 vCPU.
