// Phase 1 smoke test: boot one sandbox from the runner image, hand it a JIT config, and time it.
//
//   node --env-file=.env.local scripts/smoke.ts --repo owner/name [--image cardinal-runner:v0.1] [--vcpus 2]
//   node --env-file=.env.local scripts/smoke.ts --jit <encoded_jit_config>
//
// With --repo, the JIT config is minted via `gh api` using your own gh login (needs admin on the repo).
// Then push/re-run a `runs-on: cardinal` workflow in that repo and watch it get picked up.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Sandbox } from '@vercel/sandbox';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    jit: { type: 'string' },
    image: { type: 'string', default: process.env.CARDINAL_IMAGE ?? 'cardinal-runner:v0.1' },
    vcpus: { type: 'string', default: '2' },
    'timeout-min': { type: 'string', default: '15' },
  },
});

const runnerName = `cardinal-smoke-${Date.now()}`;
let jit = values.jit;
if (!jit) {
  if (!values.repo) throw new Error('pass --repo owner/name or --jit <config>');
  const out = execFileSync('gh', [
    'api', '-X', 'POST', `repos/${values.repo}/actions/runners/generate-jitconfig`,
    '-f', `name=${runnerName}`, '-F', 'runner_group_id=1', '-f', 'labels[]=cardinal', '-f', 'work_folder=_work',
  ]);
  jit = JSON.parse(out.toString()).encoded_jit_config as string;
}

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const sandbox = await Sandbox.create({
  name: runnerName,
  image: values.image,
  resources: { vcpus: Number(values.vcpus) },
  timeout: Number(values['timeout-min']) * 60_000,
  persistent: false,
});
const created = ms();
console.log(`sandbox up: ${created} ms (${sandbox.name})`);

try {
  const cmd = await sandbox.runCommand({
    cmd: 'bash',
    args: ['/home/runner/entrypoint.sh'],
    env: { CARDINAL_JIT_CONFIG: jit },
    detached: true,
  });
  let listening: number | undefined;
  for await (const line of cmd.logs()) {
    process.stdout.write(line.data);
    if (listening === undefined && line.data.includes('Listening for Jobs')) {
      listening = ms();
      console.log(`\n>>> Sandbox.create → "Listening for Jobs": ${listening} ms (boot ${created} + runner ${listening - created})\n`);
    }
  }
  const done = await cmd.wait();
  console.log(`runner exited ${done.exitCode} after ${ms()} ms`);
} finally {
  await sandbox.stop();
  console.log(`stopped. active CPU: ${sandbox.activeCpuUsageMs ?? '?'} ms`);
}
