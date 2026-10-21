// GitHub redirects here after the manifest flow with a one-time code. Exchange it, show the credentials once.
// Nothing is persisted: the values go into Vercel env by hand (or `vercel env add`).
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (process.env.GITHUB_APP_ID) return new Response('already configured', { status: 409 });
  const code = new URL(req.url).searchParams.get('code');
  if (!code) return new Response('missing code', { status: 400 });

  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'cardinal-setup' },
  });
  if (!res.ok) return new Response(`GitHub rejected the code: ${res.status} ${await res.text()}`, { status: 502 });
  const app = (await res.json()) as { id: number; slug: string; pem: string; webhook_secret: string; html_url: string };

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<!doctype html><meta charset="utf-8"><title>Cardinal: App created</title>
<main style="font-family:system-ui;max-width:760px;margin:48px auto;padding:0 24px;line-height:1.5">
<h1>App <code>${esc(app.slug)}</code> created</h1>
<p><strong>This page is shown once.</strong> Add these as Production environment variables in Vercel, then redeploy.</p>
<p>Fastest: paste the block below into a file and run <code>vercel env add &lt;NAME&gt; production &lt; file</code> for each, or use the dashboard.</p>
<h3>GITHUB_APP_ID</h3><pre style="background:#f4f4f4;padding:12px;overflow:auto">${app.id}</pre>
<h3>GITHUB_WEBHOOK_SECRET</h3><pre style="background:#f4f4f4;padding:12px;overflow:auto">${esc(app.webhook_secret)}</pre>
<h3>GITHUB_APP_PRIVATE_KEY</h3><pre style="background:#f4f4f4;padding:12px;overflow:auto;font-size:12px">${esc(app.pem)}</pre>
<h2>Then</h2>
<ol><li>Redeploy (Vercel → Deployments → Redeploy).</li>
<li><a href="${esc(app.html_url)}/installations/new">Install the App</a> on the repositories that should run on Cardinal.</li>
<li>Put <code>runs-on: cardinal</code> in a workflow and push.</li></ol>
</main>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
