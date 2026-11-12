import { randomUUID } from 'node:crypto';
import type { OptimiseJob } from '@bedex/shared';
import type { Logger } from 'pino';
import { AppError } from '../../lib/errors';
import type { OptimiseOutcome } from './service';

const KEEP_FINISHED_MS = 15 * 60_000;

/**
 * In-memory optimisation jobs (PRD §10: async with a progress indicator).
 * One process holds them, which suits the single PM2 instance in the PRD;
 * a multi-instance deployment would move this to BullMQ/Redis.
 */
export class OptimiseJobs {
  private readonly jobs = new Map<string, OptimiseJob>();

  constructor(private readonly logger?: Logger) {}

  start(date: string, run: (setPhase: (phase: string) => void) => Promise<OptimiseOutcome>): OptimiseJob {
    this.prune();
    const running = [...this.jobs.values()].find((j) => j.date === date && j.status === 'running');
    if (running) throw new AppError(409, 'BUSY', 'Routes for this day are already being optimised', { jobId: running.id });

    const job: OptimiseJob = {
      id: randomUUID(),
      date,
      status: 'running',
      phase: 'Starting',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      result: null,
    };
    this.jobs.set(job.id, job);

    run((phase) => {
      job.phase = phase;
    })
      .then((result) => {
        job.status = 'done';
        job.phase = 'Done';
        job.result = result;
      })
      .catch((err: unknown) => {
        job.status = 'failed';
        job.phase = 'Failed';
        // Our own errors and Google API errors are safe and useful to show; anything else isn't.
        const googleError = err instanceof Error && /^(Route Optimization API|Routes API|Google OAuth)/.test(err.message);
        job.error = err instanceof AppError || googleError ? (err as Error).message : 'Optimisation failed. Please try again.';
        this.logger?.error({ err, jobId: job.id }, 'Optimisation job failed');
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    return job;
  }

  get(id: string): OptimiseJob | undefined {
    return this.jobs.get(id);
  }

  private prune() {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) this.jobs.delete(id);
    }
  }
}
