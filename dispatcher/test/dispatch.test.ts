import { describe, expect, it, vi } from 'vitest';
import { plan, type Deps, type WorkflowJobEvent } from '@/lib/dispatch';
import { GitHubError } from '@/lib/github';

function event(overrides: Partial<WorkflowJobEvent['workflow_job']> = {}, action: WorkflowJobEvent['action'] = 'queued'): WorkflowJobEvent {
  return {
    action,
    workflow_job: {
      id: 42, run_id: 7, name: 'build', labels: ['cardinal'], runner_name: null,
      created_at: new Date().toISOString(), conclusion: null, ...overrides,
    },
    repository: { name: 'repo', owner: { login: 'acme' } },
    installation: { id: 99 },
  };
}

function deps(): Deps & { driver: { runOneJob: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } } {
  return {
    driver: {
      name: 'fake',
      runOneJob: vi.fn().mockResolvedValue({ exitCode: 0, handedOff: false, bootMs: 1000, durationMs: 5000, activeCpuMs: 2000 }),
      stop: vi.fn().mockResolvedValue(true),
    },
    generateJitConfig: vi.fn().mockResolvedValue({ runner: { id: 1, name: 'cardinal-42' }, encoded_jit_config: 'JIT' }),
    deadline: Date.now() + 800_000,
  };
}

describe('plan', () => {
  it('ignores jobs without a cardinal label and non-queued actions', () => {
    expect(plan(event({ labels: ['ubuntu-latest'] }), deps()).kind).toBe('ignore');
    expect(plan(event({}, 'in_progress'), deps()).kind).toBe('ignore');
  });

  it('dispatches a queued cardinal job with a JIT config and a watch budget under the deadline', async () => {
    const d = deps();
    const p = plan(event({ labels: ['self-hosted', 'cardinal-4x'] }), d);
    expect(p.kind).toBe('dispatch');
    await (p as { run: () => Promise<void> }).run();
    expect(d.generateJitConfig).toHaveBeenCalledWith({
      installationId: 99, owner: 'acme', repo: 'repo', name: 'cardinal-42', labels: ['cardinal-4x'],
    });
    const input = d.driver.runOneJob.mock.calls[0][0];
    expect(input).toMatchObject({ jitConfig: 'JIT', runnerName: 'cardinal-42', size: { vcpus: 4 } });
    expect(input.watchMs).toBeLessThan(800_000 - 29_000);
  });

  it('treats a 409 from generate-jitconfig as a duplicate delivery', async () => {
    const d = deps();
    d.generateJitConfig = vi.fn().mockRejectedValue(new GitHubError(409, 'exists'));
    const p = plan(event(), d) as { run: () => Promise<void> };
    await expect(p.run()).resolves.toBeUndefined();
    expect(d.driver.runOneJob).not.toHaveBeenCalled();
  });

  it('stops the sandbox by runner name when a cardinal job completes', async () => {
    const d = deps();
    const p = plan(event({ runner_name: 'cardinal-41', conclusion: 'failure' }, 'completed'), d);
    expect(p.kind).toBe('stop');
    await (p as { run: () => Promise<void> }).run();
    expect(d.driver.stop).toHaveBeenCalledWith('cardinal-41');
  });

  it('ignores completions from other runners or jobs that never got one', () => {
    expect(plan(event({ runner_name: 'GitHub Actions 3' }, 'completed'), deps()).kind).toBe('ignore');
    expect(plan(event({ runner_name: null }, 'completed'), deps()).kind).toBe('ignore');
  });
});
