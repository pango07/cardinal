import type { Deps } from './dispatch';
import { driver } from './drivers';
import { deleteRunner, generateJitConfig, getJob, lastRunJobs, queuedJobs, repoRunners } from './github';

export const deps = (deadline: number): Deps => ({
  driver,
  generateJitConfig,
  getJob,
  repoRunners,
  lastRunJobs,
  queuedJobs,
  deleteRunner,
  deadline,
});
