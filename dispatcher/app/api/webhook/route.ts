import { waitUntil } from '@vercel/functions';
import { plan, type WorkflowJobEvent } from '@/lib/dispatch';
import { driver } from '@/lib/drivers';
import { generateJitConfig } from '@/lib/github';
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
  if (eventName !== 'workflow_job') return new Response('ignored');

  const event = JSON.parse(raw) as WorkflowJobEvent;
  const p = plan(event, { driver, generateJitConfig, deadline });
  if (p.kind === 'ignore') return new Response(`ignored: ${p.reason}`);

  const delivery = req.headers.get('x-github-delivery');
  // Do the slow stuff after responding. GitHub wants a fast 2xx.
  waitUntil(
    p.run().catch((err) =>
      console.error(`cardinal ${p.kind} failed`, { delivery, jobId: event.workflow_job.id, err }),
    ),
  );
  return new Response(p.kind === 'dispatch' ? 'dispatched' : 'stopping', { status: 202 });
}
