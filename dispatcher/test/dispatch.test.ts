import { describe, expect, it, vi } from 'vitest';
import { plan, planPush, sweepRepo, type Deps, type PushEvent, type WorkflowJobEvent } from '@/lib/dispatch';
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

const runner = (name: string, labels: string[], extra: Partial<{ status: 'online' | 'offline'; busy: boolean }> = {}) => ({
  id: 1, name, status: 'online' as const, busy: false, labels: labels.map((l) => ({ name: l })), ...extra,
});

type Mocked = Deps & { [K in keyof Deps]: Deps[K] extends (...a: never[]) => unknown ? ReturnType<typeof vi.fn> : Deps[K] } & {
  driver: { runOneJob: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
};

function deps(): Mocked {
  return {
    driver: {
      name: 'fake',
      runOneJob: vi.fn().mockResolvedValue({ exitCode: 0, handedOff: false, bootMs: 1000, durationMs: 5000, activeCpuMs: 2000 }),
      stop: vi.fn().mockResolvedValue(true),
    },
    generateJitConfig: vi.fn().mockResolvedValue({ runner: { id: 1, name: 'x' }, encoded_jit_config: 'JIT' }),
    getJob: vi.fn().mockResolvedValue({ id: 42, status: 'queued', runner_name: null, labels: ['cardinal'] }),
    repoRunners: vi.fn().mockResolvedValue([]),
    lastRunJobs: vi.fn().mockResolvedValue([]),
    queuedJobs: vi.fn().mockResolvedValue([]),
    deleteRunner: vi.fn().mockResolvedValue(undefined),
    deadline: Date.now() + 800_000,
  } as unknown as Mocked;
}

const run = (p: ReturnType<typeof plan>) => (p as { run: () => Promise<void> }).run();

describe('plan', () => {
  it('ignores jobs without a cardinal label and non-queued actions', () => {
    expect(plan(event({ labels: ['ubuntu-latest'] }), deps()).kind).toBe('ignore');
    expect(plan(event({}, 'in_progress'), deps()).kind).toBe('ignore');
  });

  it('dispatches a queued cardinal job: mints a JIT config while the VM boots, watch budget under the deadline', async () => {
    const d = deps();
    const p = plan(event({ labels: ['self-hosted', 'cardinal-4x'] }), d);
    expect(p.kind).toBe('dispatch');
    await run(p);
    expect(d.generateJitConfig).toHaveBeenCalledWith({
      installationId: 99, owner: 'acme', repo: 'repo', name: 'cardinal-42', labels: ['cardinal-4x'],
    });
    const input = d.driver.runOneJob.mock.calls[0][0];
    expect(await input.jitConfig).toBe('JIT');
    expect(input).toMatchObject({ runnerName: 'cardinal-42', size: { vcpus: 4 } });
    expect(input.watchMs).toBeLessThan(800_000 - 29_000);
  });

  it('skips the boot when the job was already taken', async () => {
    const d = deps();
    d.getJob.mockResolvedValue({ id: 42, status: 'in_progress', runner_name: 'cardinal-spec-abc1234-0', labels: ['cardinal'] });
    await run(plan(event(), d));
    expect(d.driver.runOneJob).not.toHaveBeenCalled();
  });

  it('skips the boot when an idle speculative runner with matching labels is online', async () => {
    const d = deps();
    d.repoRunners.mockResolvedValue([runner('cardinal-spec-abc1234-0', ['cardinal-4x'])]);
    await run(plan(event({ labels: ['self-hosted', 'cardinal-4x'] }), d));
    expect(d.driver.runOneJob).not.toHaveBeenCalled();
  });

  it('still boots when the only speculative runner is busy, offline, or the wrong size', async () => {
    for (const r of [
      runner('cardinal-spec-a-0', ['cardinal-4x'], { busy: true }),
      runner('cardinal-spec-a-0', ['cardinal-4x'], { status: 'offline' }),
      runner('cardinal-spec-a-0', ['cardinal']),
      runner('cardinal-123', ['cardinal-4x']), // a normal runner booted for another job
    ]) {
      const d = deps();
      d.repoRunners.mockResolvedValue([r]);
      await run(plan(event({ labels: ['cardinal-4x'] }), d));
      expect(d.driver.runOneJob).toHaveBeenCalledTimes(1);
    }
  });

  it('treats a 409 from generate-jitconfig as a duplicate', async () => {
    const d = deps();
    d.generateJitConfig.mockRejectedValue(new GitHubError(409, 'exists'));
    d.driver.runOneJob.mockImplementation(async ({ jitConfig }: { jitConfig: Promise<string> }) => { await jitConfig; });
    await expect(run(plan(event(), d))).resolves.toBeUndefined();
  });

  it('stops the sandbox by runner name when a cardinal job completes', async () => {
    const d = deps();
    const p = plan(event({ runner_name: 'cardinal-41', conclusion: 'failure' }, 'completed'), d);
    expect(p.kind).toBe('stop');
    await run(p);
    expect(d.driver.stop).toHaveBeenCalledWith('cardinal-41');
  });
});

describe('planPush', () => {
  const push = (over: Partial<PushEvent> = {}): PushEvent => ({
    ref: 'refs/heads/main', after: 'abc1234567', deleted: false,
    repository: { name: 'repo', owner: { login: 'acme' } }, installation: { id: 99 }, ...over,
  });

  it('ignores tag pushes and branch deletions', () => {
    expect(planPush(push({ ref: 'refs/tags/v1' }), deps()).kind).toBe('ignore');
    expect(planPush(push({ deleted: true }), deps()).kind).toBe('ignore');
  });

  it('boots one speculative runner per cardinal job the branch ran last time, with that job\'s labels', async () => {
    const d = deps();
    d.lastRunJobs.mockResolvedValue([
      { id: 1, name: 'check', labels: ['cardinal-4x'] },
      { id: 2, name: 'android', labels: ['cardinal-android'] },
      { id: 3, name: 'lint', labels: ['ubuntu-latest'] },
    ]);
    await run(planPush(push(), d));
    expect(d.lastRunJobs).toHaveBeenCalledWith(99, 'acme', 'repo', 'main');
    expect(d.driver.runOneJob).toHaveBeenCalledTimes(2);
    const names = d.driver.runOneJob.mock.calls.map((c) => c[0].runnerName).sort();
    expect(names).toEqual(['cardinal-spec-abc1234-0', 'cardinal-spec-abc1234-1']);
    expect(d.generateJitConfig).toHaveBeenCalledWith(expect.objectContaining({ name: 'cardinal-spec-abc1234-1', labels: ['cardinal-android'] }));
    expect(d.driver.runOneJob.mock.calls[0][0]).toMatchObject({ idleTimeoutSec: 90, tags: { spec: '1' } });
  });

  it('does nothing when the branch never ran a cardinal job', async () => {
    const d = deps();
    await run(planPush(push(), d));
    expect(d.driver.runOneJob).not.toHaveBeenCalled();
  });
});

describe('sweepRepo', () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const fresh = new Date().toISOString();

  it('dispatches a cardinal job queued too long with no idle runner, leaves fresh ones and non-cardinal ones alone', async () => {
    const d = deps();
    d.queuedJobs.mockResolvedValue([
      { id: 1, labels: ['cardinal'], created_at: old, status: 'queued' },
      { id: 2, labels: ['cardinal'], created_at: fresh, status: 'queued' },
      { id: 3, labels: ['ubuntu-latest'], created_at: old, status: 'queued' },
    ]);
    const r = await sweepRepo(d, 99, 'acme', 'repo');
    expect(r.dispatched).toBe(1);
    expect(d.driver.runOneJob.mock.calls[0][0].runnerName).toBe('cardinal-1');
  });

  it('counts each idle runner against one queued job', async () => {
    const d = deps();
    d.queuedJobs.mockResolvedValue([
      { id: 1, labels: ['cardinal'], created_at: old, status: 'queued' },
      { id: 2, labels: ['cardinal'], created_at: old, status: 'queued' },
    ]);
    d.repoRunners.mockResolvedValue([runner('cardinal-spec-x-0', ['cardinal'])]);
    const r = await sweepRepo(d, 99, 'acme', 'repo');
    expect(r.dispatched).toBe(1);
    expect(d.driver.runOneJob.mock.calls[0][0].runnerName).toBe('cardinal-2');
  });

  it('removes offline cardinal runners and nothing else', async () => {
    const d = deps();
    d.repoRunners.mockResolvedValue([
      { ...runner('cardinal-555', ['cardinal'], { status: 'offline' }), id: 555 },
      { ...runner('my-mac-mini', ['macos'], { status: 'offline' }), id: 7 },
    ]);
    const r = await sweepRepo(d, 99, 'acme', 'repo');
    expect(r.removed).toBe(1);
    expect(d.deleteRunner).toHaveBeenCalledWith(99, 'acme', 'repo', 555);
  });
});
