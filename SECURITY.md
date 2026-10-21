# Security

## Reporting a vulnerability

Please report vulnerabilities through [GitHub private vulnerability reporting](../../security/advisories/new). Don't open a public issue. You'll get a response within a few days.

## Things to know before you deploy

- **Self-hosted runners and public repos.** Any workflow that can reach `runs-on: cardinal` runs code on your Vercel account. On a public repo, don't run `pull_request` workflows from forks on Cardinal. If you do, require approval for outside contributors (Settings → Actions → General → "Require approval for all outside collaborators"). Each job gets a fresh microVM that is destroyed afterwards, which limits the blast radius but doesn't remove the cost or abuse risk.
- **The GitHub App needs `Administration: write`** on installed repos, which is what lets it mint runner registrations. Install it only on the repos that need Cardinal, and keep its private key in Vercel env vars only.
- **Webhooks are HMAC-verified.** Requests without a valid `x-hub-signature-256` get a 401 before anything else happens. Use a long random `GITHUB_WEBHOOK_SECRET`.
- **JIT configs** are single-use runner credentials. They're passed to the sandbox as command environment, unset in the entrypoint once the runner starts, and never logged or baked into the image.
- Sandboxes run with `networkPolicy: allow-all`, because jobs need package registries and GitHub.
