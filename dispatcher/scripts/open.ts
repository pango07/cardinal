// Open a failed (or any kept) Cardinal job as a live machine: fork its snapshot and drop into a shell.
//
//   npm run open -- https://github.com/owner/repo/actions/runs/123/job/456
//   npm run open -- cardinal-456                       # the runner / sandbox name
//   npm run open -- <job> --code                       # print a `code --remote` hint instead of a shell
//
// Needs: `gh` logged in (to resolve the job), and this directory linked to the Cardinal Vercel project
// (`vercel link`, then `vercel env pull` for the SDK token). The fork is non-persistent and dies with
// its session; the original snapshot is untouched, so two people can open the same failure.
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Sandbox } from '@vercel/sandbox';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { minutes: { type: 'string', default: '60' }, vcpus: { type: 'string' }, 'no-shell': { type: 'boolean', default: false } },
});
const target = positionals[0];
if (!target) {
  console.error('usage: npm run open -- <job url | cardinal-<jobId>> [--minutes 60] [--vcpus 2] [--no-shell]');
  process.exit(64);
}

let source = target;
let context = '';
const m = target.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)/);
if (m) {
  const [, owner, repo, jobId] = m;
  const job = JSON.parse(execFileSync('gh', ['api', `repos/${owner}/${repo}/actions/jobs/${jobId}`]).toString()) as {
    name: string; conclusion: string | null; runner_name: string | null; head_branch: string;
  };
  if (!job.runner_name?.startsWith('cardinal-')) {
    console.error(`job ${jobId} did not run on Cardinal (runner: ${job.runner_name ?? 'none'})`);
    process.exit(1);
  }
  source = job.runner_name;
  context = ` (${owner}/${repo} · ${job.name} · ${job.head_branch} · ${job.conclusion})`;
}

const name = `open-${source.replace(/^cardinal-/, '')}-${Date.now().toString(36)}`;
console.log(`forking ${source}${context} → ${name}`);
const t0 = Date.now();
let sandbox: Sandbox;
try {
  sandbox = await Sandbox.fork({
    sourceSandbox: source,
    name,
    persistent: false,
    timeout: Number(values.minutes) * 60_000,
    ...(values.vcpus ? { resources: { vcpus: Number(values.vcpus) } } : {}),
    tags: { app: 'cardinal', role: 'open' },
  });
} catch (err) {
  console.error(`could not fork ${source}: ${(err as Error).message}`);
  console.error('Only sandboxes Cardinal kept can be opened: failed jobs (7 days) and warm bases. Green feature-branch jobs are deleted.');
  process.exit(1);
}
console.log(`up in ${Date.now() - t0} ms. Workspace: /home/runner/_work. This VM lives ${values.minutes} min, then disappears.`);
console.log(`later: vercel sandbox connect ${name}   ·   vercel sandbox stop ${name}`);

if (!values['no-shell']) {
  const r = spawnSync('vercel', ['sandbox', 'connect', name], { stdio: 'inherit' });
  if (r.status !== 0) console.log(`shell exited ${r.status}; the VM is still up until its timeout. Stop it with: vercel sandbox stop ${name}`);
}
