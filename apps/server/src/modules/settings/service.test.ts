import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger, fakeClock, makeTempDir, migratedMemoryDatabase } from "../../test-support/index.ts";
import type { Database } from "../platform/index.ts";
import { createSettingsService, InvalidSettingError, type SettingsService } from "./index.ts";

describe("SettingsService", () => {
  let temp: ReturnType<typeof makeTempDir>;
  let database: Database;
  let service: SettingsService;
  let log: ReturnType<typeof captureLogger>;
  const clock = fakeClock("2026-11-24T10:15:00.000Z");

  beforeEach(() => {
    temp = makeTempDir();
    database = migratedMemoryDatabase(temp.dir, clock);
    log = captureLogger("warn");
    service = createSettingsService({ db: database.db, clock, logger: log.logger });
  });
  afterEach(() => {
    database.sqlite.close();
    temp.cleanup();
  });

  it("answers the default when nothing is stored", () => {
    expect(service.get("globalRateLimit")).toEqual({ max: 600, timeWindowSeconds: 60 });
  });

  it("doesn't let callers change the default", () => {
    const value = service.get("globalRateLimit");
    value.max = 1;
    expect(service.get("globalRateLimit").max).toBe(600);
  });

  it("stores and reads back a value with who changed it and when", () => {
    expect(service.set("globalRateLimit", { max: 100, timeWindowSeconds: 10 }, "account-1")).toEqual({
      max: 100,
      timeWindowSeconds: 10,
    });
    expect(service.get("globalRateLimit")).toEqual({ max: 100, timeWindowSeconds: 10 });
    expect(database.sqlite.prepare("SELECT * FROM settings").all()).toEqual([
      {
        key: "globalRateLimit",
        value: '{"max":100,"timeWindowSeconds":10}',
        updated_at: "2026-11-24T10:15:00.000Z",
        updated_by: "account-1",
      },
    ]);
    clock.advance(1000);
    service.set("globalRateLimit", { max: 200, timeWindowSeconds: 20 }, null);
    expect(service.get("globalRateLimit")).toEqual({ max: 200, timeWindowSeconds: 20 });
    expect(database.sqlite.prepare("SELECT updated_at, updated_by FROM settings").get()).toEqual({
      updated_at: "2026-11-24T10:15:01.000Z",
      updated_by: null,
    });
  });

  it.each([
    [{ max: 0, timeWindowSeconds: 60 }],
    [{ max: 100_001, timeWindowSeconds: 60 }],
    [{ max: 1.5, timeWindowSeconds: 60 }],
    [{ max: 10, timeWindowSeconds: 0 }],
    [{ max: 10, timeWindowSeconds: 86_401 }],
    [{ max: 10 }],
    [{ max: 10, timeWindowSeconds: 60, extra: true }],
    ["600"],
    [null],
  ])("rejects %j", (value) => {
    expect(() => service.set("globalRateLimit", value, "account-1")).toThrow(InvalidSettingError);
    expect(service.get("globalRateLimit")).toEqual({ max: 600, timeWindowSeconds: 60 });
  });

  it("names the bad field", () => {
    expect(() => service.set("globalRateLimit", { max: 0, timeWindowSeconds: 60 }, null)).toThrow(
      expect.objectContaining({
        name: "InvalidSettingError",
        key: "globalRateLimit",
        issues: [expect.stringMatching(/^max:/)],
      }),
    );
  });

  it.each([['{"max":0,"timeWindowSeconds":60}'], ["not json"]])(
    "falls back to the default and warns when the stored value %s no longer validates",
    (stored) => {
      database.sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('globalRateLimit', ?, 'x')").run(stored);
      expect(service.get("globalRateLimit")).toEqual({ max: 600, timeWindowSeconds: 60 });
      expect(log.lines()).toEqual([expect.objectContaining({ level: 40, setting: "globalRateLimit" })]);
    },
  );
});
