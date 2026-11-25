import { problemTypes } from "@not-unreachable/contracts";
import { describe, expect, it } from "vitest";
import type { Timers } from "../platform/index.ts";
import { createConcurrencyLimiter, HASHING_CONCURRENCY, HASHING_QUEUE_TIMEOUT_MS, PasswordHashingBusyError } from "./index.ts";

/** Timers that fire only when the test says so. */
function manualTimers() {
  const pending = new Map<number, { callback: () => void; milliseconds: number }>();
  let next = 0;
  const timers: Timers<number> = {
    setTimeout: (callback, milliseconds) => {
      next += 1;
      pending.set(next, { callback, milliseconds });
      return next;
    },
    clearTimeout: (handle) => {
      pending.delete(handle);
    },
  };
  return {
    timers,
    pending,
    fireAll: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const timer of due) timer.callback();
    },
  };
}

function deferred() {
  return Promise.withResolvers<string>();
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const limiter = (timers: Timers<number>) =>
  createConcurrencyLimiter({ concurrency: HASHING_CONCURRENCY, queueTimeoutMs: HASHING_QUEUE_TIMEOUT_MS, timers });

describe("the argon2 limiter (T11)", () => {
  it("runs 4 at once; the 5th waits for a free slot", async () => {
    const clock = manualTimers();
    const run = limiter(clock.timers);
    const tasks = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    const results = tasks.map((task, index) =>
      run.run(() => {
        started.push(index);
        return task.promise;
      }),
    );
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);
    expect([...clock.pending.values()].map((timer) => timer.milliseconds)).toEqual([5000]);

    tasks[0]?.resolve("first");
    await settle();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(clock.pending.size).toBe(0);
    for (const task of tasks) task.resolve("done");
    await expect(Promise.all(results)).resolves.toEqual(["first", "done", "done", "done", "done"]);
  });

  it("fails a task that waited 5 s with the busy error, a 503 with Retry-After", async () => {
    const clock = manualTimers();
    const run = limiter(clock.timers);
    const blocking = deferred();
    const running = Array.from({ length: 4 }, () => run.run(() => blocking.promise));
    const waiting = run.run(() => Promise.resolve("never"));
    await settle();
    clock.fireAll();
    const error: unknown = await waiting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PasswordHashingBusyError);
    expect(error).toMatchObject({ status: 503, type: problemTypes.serviceUnavailable, headers: { "retry-after": "5" } });

    // The slots still work once the running tasks end.
    blocking.resolve("ok");
    await Promise.all(running);
    await expect(run.run(() => Promise.resolve("after"))).resolves.toBe("after");
  });

  it("frees the slot of a task that fails", async () => {
    const run = limiter(manualTimers().timers);
    for (let index = 0; index < HASHING_CONCURRENCY + 1; index += 1) {
      await expect(run.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    }
    await expect(run.run(() => Promise.resolve("still free"))).resolves.toBe("still free");
  });
});
