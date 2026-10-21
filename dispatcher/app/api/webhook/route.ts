import { waitUntil } from '@vercel/functions';
import { deps } from '@/lib/deps';
import { plan, planPush, type PushEvent, type WorkflowJobEvent } from '@/lib/dispatch';
import { verifySignature } from '@/lib/verify';

// Pro + Fluid compute ceiling. waitUntil work dies with the function, so jobs that outlive this
// are handed off: the sandbox keeps running and workflow_job.completed stops it.
export const maxDuration = 800;

export async function POST(req: Request) {
  const deadline = Date.now() + maxDuration * 1000;
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get('x-hub-signature-256'))) {
    return new Response('bad signature', { status: 401 });
  }

  const eventName = req.headers.get('x-github-event');
  if (eventName === 'ping') return new Response('pong');

  let p;
  let what: string;
  if (eventName === 'workflow_job') {
    const event = JSON.parse(raw) as WorkflowJobEvent;
    p = plan(event, deps(deadline));
    what = `job ${event.workflow_job.id}`;
  } else if (eventName === 'push') {
    const event = JSON.parse(raw) as PushEvent;
    p = planPush(event, deps(deadline));
    what = `push ${event.after.slice(0, 7)}`;
  } else {
    return new Response('ignored');
  }
  if (p.kind === 'ignore') return new Response(`ignored: ${p.reason}`);

  const delivery = req.headers.get('x-github-delivery');
  // Do the slow stuff after responding. GitHub wants a fast 2xx.
  const { kind, run } = p;
  waitUntil(run().catch((err) => console.error(`cardinal ${kind} failed`, { delivery, what, err })));
  return new Response(kind, { status: 202 });
}
