import { waitUntil } from '@vercel/functions';
import { deps } from '@/lib/deps';
import { sweepRepo, sweepSandboxes } from '@/lib/dispatch';
import { installationRepos } from '@/lib/github';

// Runs every minute (vercel.json). Re-dispatches cardinal jobs that have waited too long and removes dead runners.
export const maxDuration = 800;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const deadline = Date.now() + maxDuration * 1000;
  const repos = await installationRepos();
  const results: Record<string, { dispatched: number; removed: number } | string> = {};
  const work = repos.map(async ({ installationId, owner, repo }) => {
    try {
      const r = await sweepRepo(deps(deadline), installationId, owner, repo);
      results[`${owner}/${repo}`] = r;
      if (r.dispatched || r.removed) console.log('cardinal sweep', { repo: `${owner}/${repo}`, ...r });
    } catch (err) {
      results[`${owner}/${repo}`] = String(err);
      console.error('cardinal sweep failed', { repo: `${owner}/${repo}`, err });
    }
  });
  const housekeeping = sweepSandboxes(deps(deadline))
    .then((r) => { if (r.removed.length) console.log('cardinal sweep removed sandboxes', r); return r; })
    .catch((err) => { console.error('cardinal sandbox sweep failed', { err }); return { removed: [] as string[] }; });
  // Dispatches started by the sweep keep running after the response.
  waitUntil(Promise.all([...work, housekeeping]));
  await Promise.race([Promise.all(work), new Promise((r) => setTimeout(r, 20_000))]);
  return Response.json({ repos: repos.length, results, sandboxes: await Promise.race([housekeeping, new Promise((r) => setTimeout(() => r('pending'), 20_000))]) });
}
