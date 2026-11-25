import { problemTypes } from "@not-unreachable/contracts";
import { HttpProblem } from "../../http/index.ts";
import type { Timers } from "../platform/index.ts";

export const HASHING_CONCURRENCY = 4;
export const HASHING_QUEUE_TIMEOUT_MS = 5000;

/** A hash or verify waited its whole queue time for a slot: the answer is 503 with Retry-After (threat model, T11). */
export class PasswordHashingBusyError extends HttpProblem {
  constructor() {
    super(503, problemTypes.serviceUnavailable, "The server is busy. Try again in a few seconds.", {
      "retry-after": String(HASHING_QUEUE_TIMEOUT_MS / 1000),
    });
  }
}

/** Runs at most `concurrency` tasks at once; the rest wait in order, each at most `queueTimeoutMs`. */
export interface ConcurrencyLimiter {
  /** Throws {@link PasswordHashingBusyError} when no slot frees up in time. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export interface LimiterOptions<Handle> {
  readonly concurrency: number;
  readonly queueTimeoutMs: number;
  readonly timers: Timers<Handle>;
}

interface Waiter<Handle> {
  readonly start: () => void;
  readonly timer: Handle;
}

export function createConcurrencyLimiter<Handle>({ concurrency, queueTimeoutMs, timers }: LimiterOptions<Handle>): ConcurrencyLimiter {
  let running = 0;
  const queue: Waiter<Handle>[] = [];

  // A finished task hands its slot straight to the next waiter, so `running` stays the same.
  const release = (): void => {
    const next = queue.shift();
    if (next === undefined) {
      running -= 1;
      return;
    }
    timers.clearTimeout(next.timer);
    next.start();
  };

  const slot = (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter<Handle> = {
        start: resolve,
        timer: timers.setTimeout(() => {
          queue.splice(queue.indexOf(waiter), 1);
          reject(new PasswordHashingBusyError());
        }, queueTimeoutMs),
      };
      queue.push(waiter);
    });
  };

  return {
    async run(task) {
      await slot();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
