import { defaultImage } from '@/lib/config';

const REQUIRED = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];

export function GET() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  return Response.json(
    { ok: missing.length === 0, missing, image: defaultImage(), setup: missing.length ? '/setup' : undefined },
    { status: missing.length === 0 ? 200 : 503 },
  );
}
