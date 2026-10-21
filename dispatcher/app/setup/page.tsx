import { headers } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { defaultImage } from '@/lib/config';

export const dynamic = 'force-dynamic';

const REQUIRED = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];

/**
 * One-page setup for a freshly deployed dispatcher: creates the GitHub App through GitHub's manifest flow,
 * then shows the three values to paste into Vercel env. Nothing is stored server-side.
 */
export default async function Setup({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const base = `https://${host}`;
  const configured = REQUIRED.every((k) => process.env[k]);
  const org = params.org?.trim();
  const name = params.name?.trim() || 'cardinal-runner';
  const state = randomBytes(12).toString('hex');

  const manifest = {
    name,
    url: 'https://github.com/pango07/cardinal',
    description: 'Ephemeral GitHub Actions runners on Vercel Sandbox',
    hook_attributes: { url: `${base}/api/webhook`, active: true },
    redirect_url: `${base}/api/setup/callback`,
    public: false,
    default_permissions: { actions: 'read', administration: 'write', contents: 'read', metadata: 'read' },
    default_events: ['workflow_job', 'push'],
  };
  const target = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '48px auto', padding: '0 24px', lineHeight: 1.5 }}>
      <h1 style={{ marginBottom: 4 }}>Cardinal setup</h1>
      <p style={{ color: '#666', marginTop: 0 }}>{host}</p>

      <h2>1. Image</h2>
      <p>
        Runner image: <code>{defaultImage()}</code>{process.env.CARDINAL_IMAGE ? '' : ' (the public image; nothing to build)'}.
      </p>

      <h2>2. GitHub App</h2>
      {configured ? (
        <p>Configured: <code>GITHUB_APP_ID={process.env.GITHUB_APP_ID}</code>. Install the App on your repos and add <code>runs-on: cardinal</code> to a workflow.</p>
      ) : (
        <form method="post" action={target}>
          <input type="hidden" name="manifest" value={JSON.stringify(manifest)} />
          <p>
            This creates a GitHub App named <code>{name}</code> with the permissions Cardinal needs (Actions: read, Administration: write, Contents: read, Metadata: read) and its webhook pointed at <code>{base}/api/webhook</code>.
          </p>
          <p style={{ fontSize: 14, color: '#666' }}>
            For an organization, open <code>/setup?org=YOUR-ORG</code>. App names are global; use <code>?name=</code> to pick another.
          </p>
          <button type="submit" style={{ fontSize: 16, padding: '10px 18px', background: '#d7262c', color: '#fff', border: 0, borderRadius: 6, cursor: 'pointer' }}>
            Create the GitHub App
          </button>
        </form>
      )}

      <h2>3. Then</h2>
      <ol>
        <li>Paste the three values the next page shows into Vercel → Settings → Environment Variables (Production).</li>
        <li>Redeploy.</li>
        <li>Install the App on the repositories that should run on Cardinal.</li>
      </ol>
      <p style={{ fontSize: 14, color: '#666' }}>Health check: <a href="/api/health">/api/health</a></p>
    </main>
  );
}
