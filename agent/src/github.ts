import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';

let token: string | undefined;

/** GITHUB_TOKEN, or the `gh` CLI's login. Needs repo admin (for generate-jitconfig) on the polled repos. */
export function githubToken(): string {
  if (token) return token;
  token = process.env.GITHUB_TOKEN;
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    } catch {
      throw new Error('set GITHUB_TOKEN or log in with `gh auth login`');
    }
  }
  return token;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${githubToken()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cardinal-mac',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new GitHubError(res.status, `${method} ${path} → ${res.status}: ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface QueuedJob {
  id: number;
  name: string;
  run_id: number;
  labels: string[];
  created_at: string;
  html_url: string;
  repo: string;
}

interface RunsPage {
  workflow_runs: { id: number; status: string }[];
}
interface JobsPage {
  jobs: { id: number; name: string; run_id: number; status: string; labels: string[]; created_at: string; html_url: string }[];
}

/** Queued jobs in `repo` (owner/name) that carry `label`. */
export async function queuedJobs(repo: string, label: string): Promise<QueuedJob[]> {
  const runs: RunsPage['workflow_runs'] = [];
  for (const status of ['queued', 'in_progress']) {
    const page = await github<RunsPage>('GET', `/repos/${repo}/actions/runs?status=${status}&per_page=30`);
    runs.push(...page.workflow_runs);
  }
  const out: QueuedJob[] = [];
  for (const run of runs) {
    const { jobs } = await github<JobsPage>('GET', `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    for (const job of jobs) {
      if (job.status === 'queued' && job.labels.includes(label)) out.push({ ...job, repo });
    }
  }
  return out;
}

export interface JitConfig {
  runner: { id: number; name: string };
  encoded_jit_config: string;
}

export function generateJitConfig(repo: string, name: string, labels: string[]): Promise<JitConfig> {
  return github<JitConfig>('POST', `/repos/${repo}/actions/runners/generate-jitconfig`, {
    name,
    runner_group_id: 1,
    labels,
    work_folder: '_work',
  });
}

export interface RunnerRelease {
  version: string;
  url: string;
  sha256: string;
}

/** Latest actions/runner release for macOS arm64, with the SHA from the release notes. */
export async function latestRunner(): Promise<RunnerRelease> {
  const rel = await github<{ tag_name: string; body: string; assets: { name: string; browser_download_url: string; digest?: string }[] }>(
    'GET',
    '/repos/actions/runner/releases/latest',
  );
  const version = rel.tag_name.replace(/^v/, '');
  const name = `actions-runner-osx-arm64-${version}.tar.gz`;
  const asset = rel.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`no ${name} in actions/runner ${rel.tag_name}`);
  const sha =
    rel.body.match(/<!-- BEGIN SHA osx-arm64 -->([0-9a-f]{64})<!-- END SHA osx-arm64 -->/)?.[1] ??
    asset.digest?.replace(/^sha256:/, '');
  if (!sha) throw new Error(`no SHA256 for ${name}`);
  return { version, url: asset.browser_download_url, sha256: sha };
}
