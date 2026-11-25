import type { Clock } from "./clock.ts";
import type { Logger } from "./logger.ts";

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** Node's `setTimeout` can't wait longer than this; a longer wait is cut and re-armed when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The timer functions, injected so tests drive the scheduler without real time. */
export interface Timers<Handle> {
  setTimeout(callback: () => void, milliseconds: number): Handle;
  clearTimeout(handle: Handle): void;
}

export const systemTimers: Timers<NodeJS.Timeout> = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface JobDefinition {
  /** Unique; it names the job in the log. */
  readonly name: string;
  readonly intervalMs: number;
  /** How long after `start()` the first run comes; 0 when left out. */
  readonly firstRunAfterMs?: number;
  run(): void | Promise<void>;
}

export interface JobScheduler {
  /** Adds a job; after `start()`, it is scheduled at once. Throws on a name already registered. */
  register(job: JobDefinition): void;
  /** Runs each job when due, then every `intervalMs` from the start of its last run. */
  start(): void;
  /** Clears every timer; a run in progress finishes but isn't rescheduled. */
  stop(): void;
}

export interface JobSchedulerDependencies<Handle> {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timers: Timers<Handle>;
}

interface ScheduledJob<Handle> {
  readonly definition: JobDefinition;
  nextRunAt: number;
  timer: Handle | undefined;
  running: boolean;
}

export function createJobScheduler<Handle>({ clock, logger, timers }: JobSchedulerDependencies<Handle>): JobScheduler {
  const jobs = new Map<string, ScheduledJob<Handle>>();
  let started = false;

  const arm = (job: ScheduledJob<Handle>): void => {
    const delay = Math.min(Math.max(job.nextRunAt - clock.now().getTime(), 0), MAX_TIMER_MS);
    job.timer = timers.setTimeout(() => fire(job), delay);
  };

  const disarm = (job: ScheduledJob<Handle>): void => {
    if (job.timer !== undefined) timers.clearTimeout(job.timer);
    job.timer = undefined;
  };

  const finish = (job: ScheduledJob<Handle>): void => {
    job.running = false;
    if (started && job.timer === undefined) arm(job);
  };

  const fail = (job: ScheduledJob<Handle>, error: unknown): void => {
    logger.error({ err: error, job: job.definition.name }, "Scheduled job failed");
  };

  const fire = (job: ScheduledJob<Handle>): void => {
    job.timer = undefined;
    // A run still in progress (after a stop and a start) re-arms the job itself when it ends.
    if (!started || job.running) return;
    const now = clock.now().getTime();
    if (now < job.nextRunAt) {
      arm(job);
      return;
    }
    job.running = true;
    job.nextRunAt = now + job.definition.intervalMs;
    let result: void | Promise<void>;
    try {
      result = job.definition.run();
    } catch (error) {
      fail(job, error);
      finish(job);
      return;
    }
    if (result instanceof Promise) {
      result.then(
        () => finish(job),
        (error: unknown) => {
          fail(job, error);
          finish(job);
        },
      );
      return;
    }
    finish(job);
  };

  const schedule = (job: ScheduledJob<Handle>): void => {
    job.nextRunAt = clock.now().getTime() + (job.definition.firstRunAfterMs ?? 0);
    if (!job.running) arm(job);
  };

  return {
    register(definition) {
      if (jobs.has(definition.name)) throw new Error(`A job named ${definition.name} is already registered`);
      if (!(definition.intervalMs > 0)) throw new Error(`Job ${definition.name} needs a positive interval`);
      const job: ScheduledJob<Handle> = { definition, nextRunAt: 0, timer: undefined, running: false };
      jobs.set(definition.name, job);
      if (started) schedule(job);
    },
    start() {
      if (started) return;
      started = true;
      for (const job of jobs.values()) schedule(job);
    },
    stop() {
      started = false;
      for (const job of jobs.values()) disarm(job);
    },
  };
}
