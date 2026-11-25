import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobScheduler, newId, type JobDefinition, type JobScheduler } from "../platform/index.ts";
import {
  buildFilesTestApp,
  locationOf,
  silentLogger,
  tusClient,
  uploadIdOf,
  type FilesTestApp,
  type TusTestClient,
} from "../../test-support/index.ts";
import { tableRows } from "../../test-support/sessions.ts";
import { scheduleUploadsCleanup, UPLOADS_CLEANUP_JOB } from "./index.ts";

const HOUR = 3600_000;

let files: FilesTestApp;
let alice: TusTestClient;

beforeEach(async () => {
  files = await buildFilesTestApp();
  alice = tusClient(files.test, files.userCookie);
});
afterEach(async () => {
  await files.close();
});

const staged = (): string[] => readdirSync(files.stagingDir).toSorted();
const uploadIds = (): unknown[] => tableRows(files.test, "uploads").map((row) => row["id"]);
const cleanup = () => files.test.services.files.cleanup();
/** Moves the clock on, with a fresh session for alice, whose own would have timed out. */
const advance = (milliseconds: number): void => {
  files.test.clock.advance(milliseconds);
  alice = tusClient(files.test, files.test.startSession(files.user));
};

/** An upload with 5 of its 10 bytes staged; answers its id and Location. */
async function halfUpload(name = "a.bin"): Promise<{ id: string; location: string }> {
  const location = locationOf(await alice.create(10, { name }));
  expect((await alice.patch(location, 0, Buffer.from("12345"))).statusCode).toBe(204);
  return { id: uploadIdOf(location), location };
}

describe("the uploads cleanup", () => {
  it("drops an upload 24 hours after its last chunk, with its staged file", async () => {
    const { id, location } = await halfUpload();
    advance(23 * HOUR);
    expect(await cleanup()).toEqual({ expired: 0, tempFiles: 0, orphans: 0 });
    expect(uploadIds()).toEqual([id]);

    advance(HOUR);
    // Expired, though not swept yet: it can't be continued.
    expect((await alice.head(location)).statusCode).toBe(404);
    expect(await cleanup()).toEqual({ expired: 1, tempFiles: 0, orphans: 0 });
    expect(uploadIds()).toEqual([]);
    expect(staged()).toEqual([]);
  });

  it("counts from the last chunk, not the creation", async () => {
    const { id, location } = await halfUpload();
    advance(20 * HOUR);
    expect((await alice.patch(location, 5, Buffer.from("67"))).statusCode).toBe(204);
    advance(20 * HOUR);
    await cleanup();
    expect(uploadIds()).toEqual([id]);
    expect(staged()).toEqual([id]);
    advance(5 * HOUR);
    await cleanup();
    expect(uploadIds()).toEqual([]);
  });

  it("removes staged files that have no upload, and nothing else", async () => {
    const { id } = await halfUpload();
    const orphan = newId(files.test.clock);
    writeFileSync(join(files.stagingDir, orphan), "left over");
    writeFileSync(join(files.stagingDir, "notes.txt"), "not ours");
    expect(await cleanup()).toEqual({ expired: 0, tempFiles: 0, orphans: 1 });
    expect(staged()).toEqual([id, "notes.txt"].toSorted());
  });

  it("removes a .nu-upload-* file left in the target over an hour, and an expired upload's", async () => {
    mkdirSync(join(files.homeDir, "docs"));
    const location = locationOf(await alice.create(10, { folder: "docs", name: "a.bin" }));
    await alice.patch(location, 0, Buffer.from("12345"));
    const id = uploadIdOf(location);
    const temp = join(files.homeDir, "docs", `.nu-upload-${id}`);
    writeFileSync(temp, "half moved");
    files.test.database.sqlite.prepare("UPDATE uploads SET temp_name = ? WHERE id = ?").run(`.nu-upload-${id}`, id);

    advance(30 * 60_000);
    expect((await cleanup()).tempFiles).toBe(0);
    expect(existsSync(temp)).toBe(true);
    advance(31 * 60_000);
    expect((await cleanup()).tempFiles).toBe(1);
    expect(existsSync(temp)).toBe(false);
    expect(tableRows(files.test, "uploads")).toMatchObject([{ id, temp_name: null }]);

    // An expired upload's temp file goes with it.
    writeFileSync(temp, "half moved again");
    files.test.database.sqlite.prepare("UPDATE uploads SET temp_name = ? WHERE id = ?").run(`.nu-upload-${id}`, id);
    advance(24 * HOUR);
    expect(await cleanup()).toEqual({ expired: 1, tempFiles: 1, orphans: 0 });
    expect(existsSync(temp)).toBe(false);
    expect(readdirSync(join(files.homeDir, "docs"))).toEqual([]);
  });

  it("runs at startup, then hourly", async () => {
    const registered: JobDefinition[] = [];
    const jobs: JobScheduler = { register: (job) => registered.push(job), start: () => undefined, stop: () => undefined };
    scheduleUploadsCleanup(jobs, files.test.services.files);
    expect(registered).toMatchObject([{ name: UPLOADS_CLEANUP_JOB, intervalMs: HOUR }]);
    expect(registered[0]?.firstRunAfterMs ?? 0).toBe(0);

    const orphan = newId(files.test.clock);
    mkdirSync(files.stagingDir, { recursive: true });
    writeFileSync(join(files.stagingDir, orphan), "left over");
    const timers: (() => void)[] = [];
    const scheduler = createJobScheduler({
      clock: files.test.clock,
      logger: silentLogger,
      timers: { setTimeout: (callback) => timers.push(callback), clearTimeout: () => undefined },
    });
    scheduleUploadsCleanup(scheduler, files.test.services.files);
    scheduler.start();
    timers.shift()?.();
    await expect.poll(() => existsSync(join(files.stagingDir, orphan))).toBe(false);
    scheduler.stop();
  });
});
