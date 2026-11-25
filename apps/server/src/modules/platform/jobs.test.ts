import { describe, expect, it } from "vitest";
import { captureLogger, fakeClock, type FakeClock } from "../../test-support/index.ts";
import { createJobScheduler, DAY_MS, MINUTE_MS, type Timers } from "./jobs.ts";

interface FakeTimer {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

/** Timers that fire only when `advance` moves the fake clock past them. */
function fakeTimers(clock: FakeClock): Timers<number> & { advance(milliseconds: number): void; pending(): number } {
  let pending: FakeTimer[] = [];
  let nextId = 1;
  return {
    setTimeout(callback, milliseconds) {
      const timer = { id: nextId++, dueAt: clock.now().getTime() + milliseconds, callback };
      pending.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      pending = pending.filter((timer) => timer.id !== id);
    },
    advance(milliseconds) {
      const target = clock.now().getTime() + milliseconds;
      for (;;) {
        const due = pending.filter((timer) => timer.dueAt <= target).toSorted((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
        if (due === undefined) break;
        pending = pending.filter((timer) => timer !== due);
        clock.advance(Math.max(due.dueAt - clock.now().getTime(), 0));
        due.callback();
      }
      clock.advance(target - clock.now().getTime());
    },
    pending: () => pending.length,
  };
}

function setup() {
  const clock = fakeClock("2026-11-24T10:00:00.000Z");
  const timers = fakeTimers(clock);
  const log = captureLogger();
  const scheduler = createJobScheduler({ clock, logger: log.logger, timers });
  return { clock, timers, log, scheduler };
}

describe("createJobScheduler", () => {
  it("runs a job when due and then every interval", () => {
    const { clock, timers, scheduler } = setup();
    const runs: string[] = [];
    scheduler.register({
      name: "daily",
      intervalMs: DAY_MS,
      firstRunAfterMs: MINUTE_MS,
      run: () => void runs.push(clock.now().toISOString()),
    });
    timers.advance(DAY_MS);
    expect(runs).toEqual([]);

    scheduler.start();
    timers.advance(MINUTE_MS - 1);
    expect(runs).toEqual([]);
    timers.advance(1);
    expect(runs).toEqual(["2026-11-25T10:01:00.000Z"]);
    timers.advance(2 * DAY_MS);
    expect(runs).toEqual(["2026-11-25T10:01:00.000Z", "2026-11-26T10:01:00.000Z", "2026-11-27T10:01:00.000Z"]);
    scheduler.stop();
  });

  it("runs at once when no first delay is given, and schedules a job registered after start", () => {
    const { timers, scheduler } = setup();
    let runs = 0;
    scheduler.start();
    scheduler.register({ name: "now", intervalMs: 1000, run: () => void runs++ });
    timers.advance(0);
    expect(runs).toBe(1);
    timers.advance(2500);
    expect(runs).toBe(3);
    scheduler.stop();
  });

  it("refuses a duplicate name and a non-positive interval", () => {
    const { scheduler } = setup();
    scheduler.register({ name: "a", intervalMs: 1000, run: () => undefined });
    expect(() => scheduler.register({ name: "a", intervalMs: 1000, run: () => undefined })).toThrow(/already registered/);
    expect(() => scheduler.register({ name: "b", intervalMs: 0, run: () => undefined })).toThrow(/positive interval/);
  });

  it("logs a job that throws with its name and still reschedules it", () => {
    const { timers, log, scheduler } = setup();
    let runs = 0;
    scheduler.register({
      name: "broken",
      intervalMs: 1000,
      run: () => {
        runs++;
        throw new Error("boom");
      },
    });
    scheduler.start();
    timers.advance(1000);
    expect(runs).toBe(2);
    const errors = log.lines().filter((line) => line["level"] === 50);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ job: "broken", msg: "Scheduled job failed", err: { message: "boom" } });
    scheduler.stop();
  });

  it("logs a rejected async job and reschedules it after it settles", async () => {
    const { timers, log, scheduler } = setup();
    let runs = 0;
    scheduler.register({
      name: "async",
      intervalMs: 1000,
      run: async () => {
        runs++;
        throw new Error("async boom");
      },
    });
    scheduler.start();
    timers.advance(0);
    expect(runs).toBe(1);
    expect(timers.pending()).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(log.lines()).toContainEqual(
      expect.objectContaining({ level: 50, job: "async", err: expect.objectContaining({ message: "async boom" }) }),
    );
    expect(timers.pending()).toBe(1);
    timers.advance(1000);
    expect(runs).toBe(2);
    scheduler.stop();
  });

  it("never runs a job twice at once", async () => {
    const { timers, scheduler } = setup();
    let running = 0;
    let maxRunning = 0;
    let release: (() => void) | undefined;
    scheduler.register({
      name: "slow",
      intervalMs: 1000,
      run: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        running--;
      },
    });
    scheduler.start();
    timers.advance(0);
    // A stop and a start while the run is in progress must not start a second run.
    scheduler.stop();
    scheduler.start();
    timers.advance(5000);
    expect(maxRunning).toBe(1);
    release?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(running).toBe(0);
    timers.advance(0);
    expect(running).toBe(1);
    expect(maxRunning).toBe(1);
    scheduler.stop();
    release?.();
  });

  it("leaves no timer after stop, and a run in progress isn't rescheduled", async () => {
    const { timers, scheduler } = setup();
    let release: (() => void) | undefined;
    let runs = 0;
    scheduler.register({ name: "a", intervalMs: 1000, run: () => void runs++ });
    scheduler.register({
      name: "b",
      intervalMs: 1000,
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    scheduler.start();
    timers.advance(0);
    expect(timers.pending()).toBe(1);
    scheduler.stop();
    expect(timers.pending()).toBe(0);
    release?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers.pending()).toBe(0);
    timers.advance(10_000);
    expect(runs).toBe(1);
  });

  it("re-arms a wait longer than a timer can hold", () => {
    const { timers, scheduler } = setup();
    let runs = 0;
    scheduler.register({ name: "monthly", intervalMs: 40 * DAY_MS, firstRunAfterMs: 40 * DAY_MS, run: () => void runs++ });
    scheduler.start();
    timers.advance(30 * DAY_MS);
    expect(runs).toBe(0);
    timers.advance(10 * DAY_MS);
    expect(runs).toBe(1);
    scheduler.stop();
  });
});
