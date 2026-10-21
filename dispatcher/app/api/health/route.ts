const REQUIRED = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'CARDINAL_IMAGE'];

export function GET() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  return Response.json(
    { ok: missing.length === 0, missing, image: process.env.CARDINAL_IMAGE ?? null },
    { status: missing.length === 0 ? 200 : 503 },
  );
}
