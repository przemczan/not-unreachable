import { describe, expect, it } from "vitest";
import { fakeClock } from "../../test-support/index.ts";
import { MINUTE_MS, type JobDefinition, type JobScheduler } from "../platform/index.ts";
import { createMountRetries, RESOURCE_MOUNT_RETRIES_JOB, scheduleResourceRetries } from "./index.ts";

describe("the mount retries", () => {
  it("are due 1, 2 and 5 minutes after the first three failures, then every 10 minutes", () => {
    const clock = fakeClock();
    const retries = createMountRetries(clock);
    const delays: number[] = [];
    for (let failure = 0; failure < 6; failure += 1) {
      retries.recordFailure("a");
      let minutes = 0;
      while (!retries.due().includes("a")) {
        clock.advance(MINUTE_MS);
        minutes += 1;
      }
      delays.push(minutes);
    }
    expect(delays).toEqual([1, 2, 5, 10, 10, 10]);
  });

  it("start over after a success, and forget a removed share", () => {
    const clock = fakeClock();
    const retries = createMountRetries(clock);
    retries.recordFailure("a");
    retries.recordFailure("a");
    retries.recordFailure("b");
    clock.advance(MINUTE_MS);
    expect(retries.due()).toEqual(["b"]);
    retries.recordSuccess("a");
    retries.forget("b");
    clock.advance(60 * MINUTE_MS);
    expect(retries.due()).toEqual([]);
    retries.recordFailure("a");
    clock.advance(MINUTE_MS);
    expect(retries.due()).toEqual(["a"]);
  });

  it("are checked by a job every minute", async () => {
    const registered: JobDefinition[] = [];
    const jobs: JobScheduler = { register: (job) => registered.push(job), start: () => undefined, stop: () => undefined };
    let runs = 0;
    scheduleResourceRetries(jobs, {
      retryDue: async () => {
        runs += 1;
      },
    });
    expect(registered).toMatchObject([{ name: RESOURCE_MOUNT_RETRIES_JOB, intervalMs: MINUTE_MS }]);
    await registered[0]?.run();
    expect(runs).toBe(1);
  });
});
