// Creates the Cardinal GitHub App via GitHub's manifest flow and stores its credentials as
// Vercel env vars on the linked project. Nothing is printed or written to disk.
//
//   node scripts/create-app.ts --url https://<your-production-domain> [--org my-org] [--name cardinal-runner]
//
// Opens a browser; you click "Create GitHub App", then install it on the repos you want.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    org: { type: 'string' },
    name: { type: 'string', default: `cardinal-runner-${randomBytes(2).toString('hex')}` },
    port: { type: 'string', default: '3457' },
    'no-env': { type: 'boolean', default: false },
  },
});
if (!values.url) throw new Error('pass --url https://<your dispatcher production domain>');

const base = values.url.replace(/\/$/, '');
const port = Number(values.port);
const state = randomBytes(16).toString('hex');
const callback = `http://127.0.0.1:${port}/callback`;

const manifest = {
  name: values.name,
  url: 'https://github.com/pango07/cardinal',
  description: 'Ephemeral GitHub Actions runners on Vercel Sandbox',
  hook_attributes: { url: `${base}/api/webhook`, active: true },
  redirect_url: callback,
  public: false,
  default_permissions: { actions: 'read', administration: 'write', metadata: 'read' },
  default_events: ['workflow_job'],
};

const target = values.org
  ? `https://github.com/organizations/${values.org}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const server = createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? '/', callback);
  if (reqUrl.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Create Cardinal GitHub App</title>
<form method="post" action="${escapeHtml(target)}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <p>Redirecting to GitHub… <button>Continue</button></p>
</form>
<script>document.forms[0].submit()</script>`);
    return;
  }
  if (reqUrl.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  if (reqUrl.searchParams.get('state') !== state) {
    res.writeHead(400).end('state mismatch');
    return;
  }

  try {
    const code = reqUrl.searchParams.get('code');
    const conv = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'cardinal-setup' },
    });
    if (!conv.ok) throw new Error(`manifest conversion failed: ${conv.status} ${await conv.text()}`);
    const app = (await conv.json()) as { id: number; slug: string; pem: string; webhook_secret: string; html_url: string };

    if (!values['no-env']) {
      setEnv('GITHUB_APP_ID', String(app.id));
      setEnv('GITHUB_APP_PRIVATE_KEY', app.pem);
      setEnv('GITHUB_WEBHOOK_SECRET', app.webhook_secret);
    }

    const install = `${app.html_url}/installations/new`;
    res.writeHead(302, { location: install }).end();
    console.log(`\ncreated GitHub App "${app.slug}" (id ${app.id})`);
    console.log(values['no-env'] ? 'skipped Vercel env (--no-env)' : 'stored GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET in Vercel (production)');
    console.log(`\nnext:\n  1. install it on your repos: ${install}\n  2. redeploy so the env takes effect: vercel deploy --prod`);
  } catch (err) {
    res.writeHead(500).end(String(err));
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, '127.0.0.1', () => {
  const start = `http://127.0.0.1:${port}/`;
  console.log(`opening ${start} — click "Create GitHub App" on GitHub`);
  spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [start], { stdio: 'ignore' });
});

function setEnv(name: string, value: string) {
  execFileSync('vercel', ['env', 'add', name, 'production', '--force', '--yes'], {
    input: value,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
}
