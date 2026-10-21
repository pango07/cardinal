// Summarizes benchmark.yml runs: median queue time, workload time and job time per task × runner.
//   node bench/collect.ts --repo owner/name [--runs 5]
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { repo: { type: 'string' }, runs: { type: 'string', default: '5' }, workflow: { type: 'string', default: 'benchmark.yml' } },
});
if (!values.repo) throw new Error('pass --repo owner/name');

const gh = (path: string) => execFileSync('gh', ['api', path], { maxBuffer: 64 << 20 }).toString();
const ghJson = <T>(path: string) => JSON.parse(gh(path)) as T;

interface Step { name: string; started_at: string; completed_at: string; conclusion: string }
interface Job { id: number; name: string; created_at: string; started_at: string; completed_at: string; conclusion: string; steps: Step[] }

const runs = ghJson<{ workflow_runs: { id: number }[] }>(
  `repos/${values.repo}/actions/workflows/${values.workflow}/runs?status=completed&per_page=${values.runs}`,
).workflow_runs;

const rows = new Map<string, Record<string, number[]>>();
const push = (key: string, metric: string, v: number) => {
  const r = rows.get(key) ?? {};
  (r[metric] ??= []).push(v);
  rows.set(key, r);
};
const secs = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;

for (const run of runs) {
  const { jobs } = ghJson<{ jobs: Job[] }>(`repos/${values.repo}/actions/runs/${run.id}/jobs?per_page=100`);
  for (const job of jobs) {
    if (job.conclusion !== 'success') continue;
    push(job.name, 'queue', secs(job.created_at, job.started_at));
    push(job.name, 'job', secs(job.started_at, job.completed_at));
    const step = job.steps.find((s) => s.name === 'workload' && s.conclusion === 'success');
    if (step) push(job.name, 'workload', secs(step.started_at, step.completed_at));
    if (job.name.startsWith('cpu')) {
      for (const line of gh(`repos/${values.repo}/actions/jobs/${job.id}/logs`).split('\n')) {
        const m = line.match(/CARDINAL_BENCH (\{.*\})/);
        if (m) {
          const b = JSON.parse(m[1]) as { mode: string; ms: number };
          push(job.name, `cpu_${b.mode}`, b.ms / 1000);
        }
      }
    }
  }
}

const median = (xs: number[] = []) => {
  if (!xs.length) return '–';
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return m.toFixed(1);
};

console.log(`${runs.length} runs, medians in seconds\n`);
console.log('| job | n | queue → start | workload | single-core | multi-core | job total |');
console.log('|---|---|---|---|---|---|---|');
for (const [name, r] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`| ${name} | ${r.job.length} | ${median(r.queue)} | ${median(r.workload)} | ${median(r.cpu_single)} | ${median(r.cpu_multi)} | ${median(r.job)} |`);
}
