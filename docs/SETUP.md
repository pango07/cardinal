# Setup

About 30 minutes, start to green check. You need:

- A **Vercel Pro** team. Hobby caps functions at 300 s and sandboxes at 45 min.
- `vercel` CLI ≥ 56, logged in (`vercel login`)
- Docker with `buildx` (Docker Desktop is fine; on Apple Silicon it emulates amd64)
- `jq`, and a GitHub account that can create Apps and admin the target repos

## 1. Create the Vercel project

```bash
cd dispatcher
npm install
vercel link            # create a new project, e.g. "cardinal"
```

The image registry, sandboxes and dispatcher all live in this one project. That's how OIDC auth works without tokens.

## 2. Build and push the runner image

```bash
# still in dispatcher/, so the push targets the linked project
RUNNER_VERSION=2.338.0 ../image/push.sh v0.1
```

This creates a `cardinal-runner` repository in Vercel Container Registry, logs Docker in, builds `linux/amd64` and pushes. Expect about 380 MB. Pinning `RUNNER_VERSION` keeps the tag reproducible. Without it you get the latest actions/runner release. actions/runner refuses to run once it's very out of date, so rebuild every few months.

The image lands at `vcr.vercel.com/<team-slug>/<project>/cardinal-runner:<tag>`. To push somewhere else, set `CARDINAL_IMAGE_REF=<that path, no tag>`. On Apple Silicon the amd64 build runs under emulation and takes a few minutes; the push is about 380 MB.

## 3. Deploy the dispatcher

```bash
vercel env add CARDINAL_IMAGE production     # cardinal-runner:v0.1
vercel deploy --prod
```

Find the production domain with `vercel inspect <deployment-url>` under **Aliases**. Use the short one (`https://<project>-<random>.vercel.app` or your custom domain). The `…-<team-slug>.vercel.app` alias and preview URLs are behind Vercel Deployment Protection, so GitHub would get a redirect to a login page.

## 4. Create the GitHub App

```bash
npm run create-app -- --url https://<your-production-domain>
# org-owned App: add --org <org>.  App names are global; pick one with --name <name>
```

This opens your browser on a pre-filled "Create GitHub App" page (GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)). Click **Create**, and the script:

- receives the App ID, private key and webhook secret on a localhost callback
- stores them as `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` production env vars in the linked Vercel project. Nothing is printed or written to disk
- sends you to the App's install page. Install it on **only** the repos that should run on Cardinal

The App gets **Actions: Read**, **Administration: Read & write** (what lets it mint JIT runner configs) and **Metadata: Read**, and subscribes to **Workflow job** events.

<details><summary>Doing it by hand instead</summary>

Create an App at https://github.com/settings/apps/new with webhook URL `https://<domain>/api/webhook`, a random webhook secret (`openssl rand -hex 32`), the permissions and event above. Then generate a private key and set the three env vars:

```bash
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production < path/to/key.pem
vercel env add GITHUB_WEBHOOK_SECRET production
```
</details>

## 5. Redeploy

```bash
vercel deploy --prod                               # env changes need a redeploy
```

Optional knobs (defaults in brackets):

| Var | Meaning |
|---|---|
| `CARDINAL_DEFAULT_SIZE` [`cardinal`] | Size used for plain `runs-on: cardinal` (`cardinal-4x` to make 4 vCPU the default) |
| `CARDINAL_TIMEOUT_MINUTES` [60] | Sandbox timeout = max job length. Pro allows up to 1440 |
| `CARDINAL_IDLE_TIMEOUT_SECONDS` [300] | Runner gives up if no job arrives in this window |
| `CARDINAL_REGION` [project default / `iad1`] | Sandbox region |

## 6. Check it's wired up

```bash
curl https://<your-url>/api/health          # {"ok":true,...}
```

In the App settings → **Advanced** → **Recent Deliveries**, the initial `ping` should show a 200 `pong`. If it shows 401, the webhook secret doesn't match.

## 7. Run a job

Copy [`examples/hello-cardinal.yml`](../examples/hello-cardinal.yml) to `.github/workflows/` in an installed repo and push. Expect:

1. The job sits in **Queued** for a few seconds while the sandbox boots
2. The runner `cardinal-<job id>` appears under the repo's Settings → Actions → Runners
3. The job goes green. The runner disappears, and the sandbox shows as stopped in the Vercel dashboard (Sandboxes tab)

Watch it live with `vercel logs <your-url>`. Each job ends with a `cardinal job summary {...}` line that has boot time, duration, active CPU and estimated cost.

## Local smoke test (optional)

Boot one sandbox by hand, without the App, using your own `gh` login:

```bash
cd dispatcher
vercel env pull                 # VERCEL_OIDC_TOKEN for the SDK, valid ~12h
npm run smoke -- --repo you/some-repo --image cardinal-runner:v0.1
# now trigger a runs-on: cardinal workflow in that repo
```

It prints `Sandbox.create → "Listening for Jobs": N ms` and streams the job's output.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Job stuck in Queued, no runner appears | Check `vercel logs`. `Resource not accessible by integration` means the App lacks Administration write or isn't installed on the repo |
| Runner appears, job never starts | Job labels don't match: `runs-on` must be exactly `cardinal`, `cardinal-4x` or `cardinal-8x` |
| `CARDINAL_IMAGE is not set` / image not found | Step 2 pushed to a different project than the one the dispatcher is deployed in |
| Job fails on `container:` / `services:` / Docker actions | Unsupported, see [LIMITS.md](LIMITS.md) |
