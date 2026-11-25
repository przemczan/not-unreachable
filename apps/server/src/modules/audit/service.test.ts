import { auditPageQuerySchema, type AuditFilter } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { captureLogger, fakeClock, makeTempDir, migratedMemoryDatabase, type FakeClock } from "../../test-support/index.ts";
import { DAY_MS, type Database } from "../platform/index.ts";
import { createSettingsService, type SettingsService } from "../settings/index.ts";
import { createAuditService, InvalidAuditCursorError, type AuditEventInput, type AuditService } from "./index.ts";

const alice = { kind: "account", accountId: "0192f1c4-0000-7000-8000-000000000001", username: "alice" } as const;
const bob = { kind: "account", accountId: "0192f1c4-0000-7000-8000-000000000002", username: "bob" } as const;

const signOut = (actor: AuditEventInput<"sign-out">["actor"] = alice): AuditEventInput<"sign-out"> => ({
  action: "sign-out",
  actor,
  outcome: "succeeded",
  details: {},
});

const query = (input: z.input<typeof auditPageQuerySchema> = {}) => auditPageQuerySchema.parse(input);

const csvLines = (csv: string) => csv.split("\r\n").slice(0, -1);

describe("AuditService", () => {
  let temp: ReturnType<typeof makeTempDir>;
  let database: Database;
  let clock: FakeClock;
  let log: ReturnType<typeof captureLogger>;
  let settings: SettingsService;
  let audit: AuditService;

  beforeEach(() => {
    temp = makeTempDir();
    clock = fakeClock("2026-11-24T10:15:00.000Z");
    database = migratedMemoryDatabase(temp.dir, clock);
    log = captureLogger();
    settings = createSettingsService({ db: database.db, clock, logger: log.logger });
    audit = createAuditService({ db: database.db, clock, logger: log.logger, settings });
  });
  afterEach(() => {
    database.sqlite.close();
    temp.cleanup();
  });

  const storedRows = () => database.sqlite.prepare("SELECT * FROM audit_events ORDER BY at, id").all();

  describe("record", () => {
    it("stores the event with its actor, target and origin", () => {
      audit.record({
        action: "sign-in.failed",
        actor: alice,
        outcome: "failed",
        target: { kind: "account", id: alice.accountId },
        origin: { ip: "203.0.113.7", userAgent: "Firefox" },
        details: { method: "password", reason: "wrong-password" },
      });
      expect(storedRows()).toEqual([
        {
          id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
          at: "2026-11-24T10:15:00.000Z",
          actor_kind: "account",
          actor_account_id: alice.accountId,
          actor_username: "alice",
          action: "sign-in.failed",
          target_kind: "account",
          target_id: alice.accountId,
          outcome: "failed",
          ip: "203.0.113.7",
          user_agent: "Firefox",
          details: '{"method":"password","reason":"wrong-password"}',
        },
      ]);
    });

    it("stores no account fields for a system actor, and nulls without a target or origin", () => {
      audit.record({ action: "system.started", actor: { kind: "system" }, outcome: "succeeded", details: { version: "1.0.0" } });
      expect(storedRows()).toEqual([
        expect.objectContaining({
          actor_kind: "system",
          actor_account_id: null,
          actor_username: null,
          target_kind: null,
          ip: null,
          user_agent: null,
        }),
      ]);
    });

    it("keeps the first 256 characters of the user agent", () => {
      audit.record({ ...signOut(), origin: { ip: null, userAgent: `${"é".repeat(250)}${"😀".repeat(10)}` } });
      expect(storedRows()).toEqual([expect.objectContaining({ user_agent: `${"é".repeat(250)}${"😀".repeat(6)}` })]);
    });

    it("writes a copy to the JSON log", () => {
      audit.record({
        action: "settings.changed",
        actor: alice,
        outcome: "succeeded",
        origin: { ip: "203.0.113.7", userAgent: "Firefox" },
        details: { keys: ["auditRetentionDays"] },
      });
      const [row] = z.array(z.object({ id: z.string() })).parse(storedRows());
      expect(log.lines()).toContainEqual(
        expect.objectContaining({
          level: 30,
          msg: "Audit event",
          audit: {
            id: row?.id,
            at: "2026-11-24T10:15:00.000Z",
            actorKind: "account",
            actorAccountId: alice.accountId,
            actorUsername: "alice",
            action: "settings.changed",
            targetKind: null,
            targetId: null,
            outcome: "succeeded",
            ip: "203.0.113.7",
            userAgent: "Firefox",
            details: { keys: ["auditRetentionDays"] },
          },
        }),
      );
    });

    it("rejects details that don't match the action's schema, storing nothing", () => {
      const bad = { action: "sign-out", actor: alice, outcome: "succeeded", details: { password: "hunter2" } };
      // @ts-expect-error -- the type refuses it too; the check also holds at run time
      expect(() => audit.record(bad)).toThrow(z.ZodError);
      expect(() =>
        audit.record({ action: "sign-in.locked", actor: alice, outcome: "denied", details: { failures: 0, lockedUntil: "soon" } }),
      ).toThrow(z.ZodError);
      expect(storedRows()).toEqual([]);
      expect(log.lines()).toEqual([]);
    });
  });

  describe("list", () => {
    it("pages newest first across events that share a time", () => {
      for (let index = 0; index < 5; index++) audit.record(signOut());
      clock.advance(1000);
      for (let index = 0; index < 3; index++) audit.record(signOut(bob));
      const all = audit.list(query({ limit: 200 })).events;
      expect(all).toHaveLength(8);
      expect(all.slice(0, 3).map((event) => event.actorUsername)).toEqual(["bob", "bob", "bob"]);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = audit.list(query({ limit: 3, ...(cursor === undefined ? {} : { cursor }) }));
        seen.push(...page.events.map((event) => event.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor !== undefined);
      expect(pages).toBe(3);
      expect(seen).toEqual(all.map((event) => event.id));
    });

    it("answers the contract's event shape and no cursor on the last page", () => {
      audit.record({
        action: "account.changed",
        actor: alice,
        outcome: "succeeded",
        target: { kind: "account", id: alice.accountId },
        details: { fields: ["email"] },
      });
      expect(audit.list(query())).toEqual({
        events: [
          {
            id: expect.any(String),
            at: "2026-11-24T10:15:00.000Z",
            actorKind: "account",
            actorAccountId: alice.accountId,
            actorUsername: "alice",
            action: "account.changed",
            targetKind: "account",
            targetId: alice.accountId,
            outcome: "succeeded",
            ip: null,
            userAgent: null,
            details: { fields: ["email"] },
          },
        ],
        nextCursor: null,
      });
    });

    describe("filters", () => {
      beforeEach(() => {
        audit.record(signOut()); // 10:15:00
        clock.advance(60_000);
        audit.record({ ...signOut(bob), outcome: "failed" }); // 10:16:00
        clock.advance(60_000);
        audit.record({ action: "system.started", actor: { kind: "system" }, outcome: "succeeded", details: { version: "1" } }); // 10:17:00
      });

      it.each<[AuditFilter, string[]]>([
        [{}, ["system.started@10:17", "sign-out@10:16", "sign-out@10:15"]],
        [{ from: "2026-11-24T10:16:00Z" }, ["system.started@10:17", "sign-out@10:16"]],
        [{ from: "2026-11-24T10:16:00.000Z" }, ["system.started@10:17", "sign-out@10:16"]],
        [{ to: "2026-11-24T10:16:00Z" }, ["sign-out@10:15"]],
        [{ from: "2026-11-24T10:15:30Z", to: "2026-11-24T10:17:00.000Z" }, ["sign-out@10:16"]],
        [{ actorKind: "system" }, ["system.started@10:17"]],
        [{ actorKind: "account" }, ["sign-out@10:16", "sign-out@10:15"]],
        [{ actorUsername: "bob" }, ["sign-out@10:16"]],
        [{ actorUsername: "bo" }, []],
        [{ action: "sign-out" }, ["sign-out@10:16", "sign-out@10:15"]],
        [{ outcome: "failed" }, ["sign-out@10:16"]],
        [{ action: "sign-out", outcome: "succeeded" }, ["sign-out@10:15"]],
      ])("%j", (filter, expected) => {
        const events = audit.list(query(filter)).events;
        expect(events.map((event) => `${event.action}@${event.at.slice(11, 16)}`)).toEqual(expected);
      });

      it("keeps the filter across pages", () => {
        const first = audit.list(query({ actorKind: "account", limit: 1 }));
        expect(first.events.map((event) => event.actorUsername)).toEqual(["bob"]);
        const second = audit.list(query({ actorKind: "account", limit: 1, cursor: first.nextCursor ?? "" }));
        expect(second).toEqual({ events: [expect.objectContaining({ actorUsername: "alice" })], nextCursor: null });
      });
    });

    it.each([
      "not-a-cursor",
      "!!!",
      Buffer.from("{}").toString("base64url"),
      Buffer.from('["2026-11-24T10:15:00.000Z"]').toString("base64url"),
      Buffer.from('["yesterday","0192f1c4-0000-7000-8000-000000000001"]').toString("base64url"),
      Buffer.from('["2026-11-24T10:15:00.000Z","not-a-uuid"]').toString("base64url"),
    ])("refuses the cursor %j", (cursor) => {
      expect(() => audit.list(query({ cursor }))).toThrow(InvalidAuditCursorError);
    });
  });

  describe("exportCsv", () => {
    it("writes a header and one escaped row per event, newest first", () => {
      audit.record({
        action: "sign-in.failed",
        actor: { kind: "anonymous" },
        outcome: "failed",
        target: { kind: "username", id: "=cmd|' /C calc'!A0" },
        origin: { ip: "203.0.113.7", userAgent: '-Mozilla "5.0", x' },
        details: { method: "password", reason: "unknown-account" },
      });
      clock.advance(1000);
      audit.record(signOut());
      expect(csvLines(audit.exportCsv({}))).toEqual([
        "at,actor kind,actor username,actor account id,action,target kind,target id,outcome,ip,user agent,details",
        `2026-11-24T10:15:01.000Z,account,alice,${alice.accountId},sign-out,,,succeeded,,,{}`,
        `2026-11-24T10:15:00.000Z,anonymous,,,sign-in.failed,username,'=cmd|' /C calc'!A0,failed,203.0.113.7,"'-Mozilla ""5.0"", x","{""method"":""password"",""reason"":""unknown-account""}"`,
      ]);
    });

    it("applies the filter", () => {
      audit.record(signOut());
      audit.record(signOut(bob));
      const lines = csvLines(audit.exportCsv({ actorUsername: "bob" }));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(",bob,");
    });
  });

  describe("purgeExpired", () => {
    it("deletes events older than the retention and records audit.purged with the count", () => {
      audit.record(signOut()); // 2026-11-24
      clock.advance(10 * DAY_MS);
      audit.record(signOut(bob)); // 2026-12-04
      clock.advance(360 * DAY_MS); // 2027-11-29: alice's event is 370 days old, bob's 360

      expect(audit.purgeExpired()).toBe(1);
      const events = audit.list(query()).events;
      expect(events.map((event) => event.action)).toEqual(["audit.purged", "sign-out"]);
      expect(events[0]).toMatchObject({
        actorKind: "system",
        outcome: "succeeded",
        details: { count: 1, before: "2026-11-29T10:15:00.000Z" },
      });
      expect(events[1]?.actorUsername).toBe("bob");
    });

    it("records audit.purged even when nothing expired", () => {
      audit.record(signOut());
      // Events of the same millisecond have no set order, so the purge comes a second later.
      clock.advance(1000);
      expect(audit.purgeExpired()).toBe(0);
      expect(audit.list(query()).events.map((event) => [event.action, event.details])).toEqual([
        ["audit.purged", { count: 0, before: "2025-11-24T10:15:01.000Z" }],
        ["sign-out", {}],
      ]);
    });

    it("follows a change of the retention setting", () => {
      audit.record(signOut());
      clock.advance(40 * DAY_MS);
      expect(audit.purgeExpired()).toBe(0);
      settings.set("auditRetentionDays", 30, null);
      expect(audit.purgeExpired()).toBe(1);
      expect(audit.list(query()).events.map((event) => event.action)).toEqual(["audit.purged", "audit.purged"]);
    });
  });
});
