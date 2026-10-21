// Runs the selected driver against real compute. Skipped unless CARDINAL_DRIVER_TEST=1.
//
//   CARDINAL_DRIVER_TEST=1 CARDINAL_IMAGE=cardinal-runner:v0.3 npm run driver-test
//
// The JIT config is garbage on purpose: the runner must start, reject it, and exit non-zero, which exercises
// boot, the entrypoint, output streaming, teardown and `stop` without touching GitHub.
import { describe, expect, it } from 'vitest';
import { driver } from '@/lib/drivers';

const enabled = process.env.CARDINAL_DRIVER_TEST === '1';

describe.skipIf(!enabled)(`driver contract: ${driver.name}`, () => {
  it('boots, runs the entrypoint, exits non-zero on a bad JIT config, and tears down', async () => {
    const t0 = Date.now();
    const result = await driver.runOneJob({
      jitConfig: Promise.resolve(Buffer.from('not a jit config').toString('base64')),
      size: { vcpus: 2, memoryMb: 4096, timeoutMs: 5 * 60_000 },
      jobId: 0,
      runnerName: `cardinal-contract-${Date.now().toString(36)}`,
      idleTimeoutSec: 30,
      watchMs: 4 * 60_000,
    });
    console.log(`${driver.name}: boot ${result.bootMs} ms, total ${Date.now() - t0} ms, exit ${result.exitCode}`);
    expect(result.handedOff).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.bootMs).toBeLessThan(60_000);
    expect(Date.now() - t0).toBeLessThan(3 * 60_000);
  }, 4 * 60_000);

  it('stop on a name that never existed is harmless and reports nothing running', async () => {
    await expect(driver.stop(`cardinal-never-${Date.now().toString(36)}`)).resolves.toBe(false);
  }, 60_000);

  it('hands off when the watch budget is tiny, then stop tears it down', async () => {
    const name = `cardinal-contract-handoff-${Date.now().toString(36)}`;
    const result = await driver.runOneJob({
      jitConfig: Promise.resolve(Buffer.from('not a jit config').toString('base64')),
      size: { vcpus: 2, memoryMb: 4096, timeoutMs: 5 * 60_000 },
      jobId: 0,
      runnerName: name,
      idleTimeoutSec: 120,
      watchMs: 1, // give up immediately after boot
    });
    expect(result.handedOff).toBe(true);
    expect(result.exitCode).toBeNull();
    const stopped = await driver.stop(name);
    expect(typeof stopped).toBe('boolean');
    await expect(driver.stop(name)).resolves.toBe(false);
  }, 4 * 60_000);
});
