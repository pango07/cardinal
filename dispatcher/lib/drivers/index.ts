import type { RunnerDriver } from './types';
import { vercelSandboxDriver } from './vercel-sandbox';

export type { RunnerDriver, RunnerSize, RunOneJobInput, RunOneJobResult } from './types';

export const driver: RunnerDriver = vercelSandboxDriver;
