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
