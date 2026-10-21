import type { RunnerDriver } from './types';
import { vercelSandboxDriver } from './vercel-sandbox';

export type { RunnerDriver, RunnerSize, RunOneJobInput, RunOneJobResult, SnapshotOps } from './types';

const drivers: Record<string, RunnerDriver> = {
  'vercel-sandbox': vercelSandboxDriver,
  // Add yours here and select it with CARDINAL_DRIVER. See docs/DRIVERS.md.
};

const selected = process.env.CARDINAL_DRIVER ?? 'vercel-sandbox';
if (!drivers[selected]) throw new Error(`unknown CARDINAL_DRIVER "${selected}"; known: ${Object.keys(drivers).join(', ')}`);

export const driver: RunnerDriver = drivers[selected];
