# Contributing

Issues and PRs are welcome. Cardinal is deliberately small, so please open an issue before a large change.

## Layout

| Path | What |
|---|---|
| `image/` | Runner image: Dockerfile, `install-runner.sh` (SHA-verified actions/runner), `entrypoint.sh` |
| `dispatcher/` | Next.js app on Vercel. `app/api/webhook/route.ts` is the entry point |
| `dispatcher/lib/dispatch.ts` | Pure-ish event → action logic; most tests live against this |
| `dispatcher/lib/drivers/` | `RunnerDriver` interface plus the Vercel Sandbox driver |

## Develop

```bash
cd dispatcher
npm install
npm test
npm run typecheck
npm run build
```

Image:

```bash
docker buildx build --platform linux/amd64 --load -t cardinal-runner:dev image/
docker run --rm cardinal-runner:dev ./bin/Runner.Listener --version
```

End to end against real infrastructure: see `npm run smoke` in [docs/SETUP.md](docs/SETUP.md).

## Adding a driver

Implement `RunnerDriver` (`dispatcher/lib/drivers/types.ts`):

- `runOneJob` boots compute from the runner image, runs `/home/runner/entrypoint.sh` with `CARDINAL_JIT_CONFIG` in its environment, and tears the compute down when it exits. If the job outlives `watchMs`, return `handedOff: true` and leave the compute running.
- `stop(runnerName)` must be idempotent. It's called on every `workflow_job.completed` for a `cardinal-*` runner.

Then select it in `dispatcher/lib/drivers/index.ts`.

## Measurements

If you measure something from [docs/FINDINGS.md](docs/FINDINGS.md) (boot times, arm64, snapshots), please PR the numbers along with how you got them.
