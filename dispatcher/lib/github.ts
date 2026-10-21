import { createAppAuth } from '@octokit/auth-app';

const API = 'https://api.github.com';

let auth: ReturnType<typeof createAppAuth> | undefined;

function appAuth() {
  // auth-app caches installation tokens in-memory until shortly before they expire (1h).
  auth ??= createAppAuth({
    appId: required('GITHUB_APP_ID'),
    privateKey: required('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
  });
  return auth;
}

async function installationToken(installationId: number): Promise<string> {
  const { token } = await appAuth()({ type: 'installation', installationId });
  return token;
}

export async function github<T>(
  installationId: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await installationToken(installationId)}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cardinal-dispatcher',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new GitHubError(res.status, `${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface JitConfig {
  runner: { id: number; name: string };
  encoded_jit_config: string;
}

export function generateJitConfig(input: {
  installationId: number;
  owner: string;
  repo: string;
  name: string;
  labels: string[];
}): Promise<JitConfig> {
  return github<JitConfig>(
    input.installationId,
    'POST',
    `/repos/${input.owner}/${input.repo}/actions/runners/generate-jitconfig`,
    { name: input.name, runner_group_id: 1, labels: input.labels, work_folder: '_work' },
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// ---- Read side: what's queued, what's running, what ran last time -------------------------------

export interface RepoRunner {
  id: number;
  name: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: { name: string }[];
}

export async function repoRunners(installationId: number, owner: string, repo: string): Promise<RepoRunner[]> {
  const page = await github<{ runners: RepoRunner[] }>(installationId, 'GET', `/repos/${owner}/${repo}/actions/runners?per_page=100`);
  return page.runners;
}

export function deleteRunner(installationId: number, owner: string, repo: string, runnerId: number): Promise<void> {
  return github(installationId, 'DELETE', `/repos/${owner}/${repo}/actions/runners/${runnerId}`);
}

export interface JobSummary {
  id: number;
  run_id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending';
  labels: string[];
  runner_name: string | null;
  created_at: string;
}

export function getJob(installationId: number, owner: string, repo: string, jobId: number): Promise<JobSummary> {
  return github<JobSummary>(installationId, 'GET', `/repos/${owner}/${repo}/actions/jobs/${jobId}`);
}

interface RunsPage {
  workflow_runs: { id: number; workflow_id: number; status: string; created_at: string }[];
}

async function runJobs(installationId: number, owner: string, repo: string, runId: number): Promise<JobSummary[]> {
  const page = await github<{ jobs: JobSummary[] }>(installationId, 'GET', `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`);
  return page.jobs;
}

/** Jobs from the most recent run of each workflow on `branch` (any event). The best guess at what the next push runs. */
export async function lastRunJobs(installationId: number, owner: string, repo: string, branch: string): Promise<JobSummary[]> {
  let { workflow_runs: runs } = await github<RunsPage>(
    installationId, 'GET', `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`,
  );
  if (!runs.length) ({ workflow_runs: runs } = await github<RunsPage>(installationId, 'GET', `/repos/${owner}/${repo}/actions/runs?per_page=10`));
  const latestPerWorkflow = new Map<number, number>();
  for (const run of runs) if (!latestPerWorkflow.has(run.workflow_id)) latestPerWorkflow.set(run.workflow_id, run.id);
  const jobs = await Promise.all([...latestPerWorkflow.values()].map((id) => runJobs(installationId, owner, repo, id)));
  return jobs.flat();
}

/** Every job currently queued in the repo. */
export async function queuedJobs(installationId: number, owner: string, repo: string): Promise<JobSummary[]> {
  const runs: RunsPage['workflow_runs'] = [];
  for (const status of ['queued', 'in_progress']) {
    const page = await github<RunsPage>(installationId, 'GET', `/repos/${owner}/${repo}/actions/runs?status=${status}&per_page=30`);
    runs.push(...page.workflow_runs);
  }
  const jobs = await Promise.all(runs.map((run) => runJobs(installationId, owner, repo, run.id)));
  return jobs.flat().filter((job) => job.status === 'queued');
}

// ---- App level (JWT): which installations and repos exist, for the sweep -------------------------

async function appJwt(): Promise<string> {
  const { token } = await appAuth()({ type: 'app' });
  return token;
}

export interface InstallationRepo {
  installationId: number;
  owner: string;
  repo: string;
}

export async function installationRepos(): Promise<InstallationRepo[]> {
  const res = await fetch(`${API}/app/installations?per_page=100`, {
    headers: { authorization: `Bearer ${await appJwt()}`, accept: 'application/vnd.github+json', 'user-agent': 'cardinal-dispatcher' },
  });
  if (!res.ok) throw new GitHubError(res.status, `GET /app/installations → ${res.status}: ${await res.text()}`);
  const installations = (await res.json()) as { id: number }[];
  const out: InstallationRepo[] = [];
  for (const { id } of installations) {
    const page = await github<{ repositories: { name: string; owner: { login: string } }[] }>(id, 'GET', '/installation/repositories?per_page=100');
    for (const r of page.repositories) out.push({ installationId: id, owner: r.owner.login, repo: r.name });
  }
  return out;
}
