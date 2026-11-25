import { problemTypes } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpProblem } from "../../http/index.ts";
import {
  createTestServices,
  fakeClock,
  makeTempDir,
  migratedMemoryDatabase,
  testSecrets,
  type FakeClock,
} from "../../test-support/index.ts";
import type { AccountRecord } from "../accounts/index.ts";
import type { Database } from "../platform/index.ts";
import {
  createSignInLimits,
  delayAfterFailure,
  perIpLimits,
  signInFailures,
  signInLocks,
  subjectKeyOf,
  sweepSignInLimits,
  type SignInAttempt,
  type SignInGate,
} from "./index.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe("delayAfterFailure", () => {
  it("is 0 before the threshold, then 1 s doubling per failure, capped at 60 s", () => {
    expect([1, 2, 3, 4].map((n) => delayAfterFailure(n, 5))).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 11, 12, 100].map((n) => delayAfterFailure(n, 5) / SECOND)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });
});

describe("createSignInLimits", () => {
  let temp: ReturnType<typeof makeTempDir>;
  let database: Database;
  let clock: FakeClock;
  let services: ReturnType<typeof createTestServices>;
  let gate: SignInGate;
  let alice: AccountRecord;

  /** `account` is null for an identifier that names no account. */
  const attempt = (
    ip = "203.0.113.1",
    account: AccountRecord | null = alice,
    identifier = account?.username ?? "mallory",
  ): SignInAttempt => ({
    kind: "sign-in",
    ip,
    userAgent: "test",
    identifier,
    account: account ?? undefined,
  });

  const refusedBefore = (ip: string): HttpProblem | undefined => {
    try {
      void gate.beforeAttempt({ kind: "sign-in", ip, userAgent: "test" });
      return undefined;
    } catch (error) {
      if (error instanceof HttpProblem) return error;
      throw error;
    }
  };

  const audited = (action: "rate-limit.triggered" | "sign-in.locked") => services.audit.list({ limit: 200, action }).events;

  /** How many sign-in failure and lock rows are stored. */
  const storedRows = () => ({
    failures: database.db.select().from(signInFailures).all().length,
    locks: database.db.select().from(signInLocks).all().length,
  });

  /** A failed proof, as the service makes it: checked by the gate, then recorded. */
  const fail = async (ip = "203.0.113.1", account: AccountRecord | null = alice) => {
    const refusal = await gate.beforePasswordCheck(attempt(ip, account));
    if (refusal === undefined) await gate.recordFailure(attempt(ip, account));
    return refusal;
  };

  const failFromManyIps = async (count: number, first = 0, account: AccountRecord | null = alice) => {
    for (let i = first; i < first + count; i++) expect(await fail(`198.51.100.${i + 1}`, account)).toBeUndefined();
  };

  beforeEach(() => {
    temp = makeTempDir();
    clock = fakeClock();
    database = migratedMemoryDatabase(temp.dir, clock);
    services = createTestServices(database, clock);
    gate = createSignInLimits({ db: database.db, clock, settings: services.settings, audit: services.audit, secrets: testSecrets });
    alice = services.accounts.create({ username: "alice", email: "alice@example.com", displayName: "Alice", role: "admin" });
  });
  afterEach(() => {
    database.sqlite.close();
    temp.cleanup();
  });

  describe("per IP", () => {
    it("allows 10 attempts a minute, then answers 429 with Retry-After until the minute is over", () => {
      for (let i = 0; i < 10; i++) expect(refusedBefore("203.0.113.1")).toBeUndefined();
      const refused = refusedBefore("203.0.113.1");
      expect(refused).toMatchObject({ status: 429, type: problemTypes.tooManyAttempts, headers: { "retry-after": "60" } });
      clock.advance(59 * SECOND);
      expect(refusedBefore("203.0.113.1")?.headers["retry-after"]).toBe("1");
      expect(refusedBefore("203.0.113.2")).toBeUndefined();
      clock.advance(SECOND);
      expect(refusedBefore("203.0.113.1")).toBeUndefined();
    });

    it("allows 50 attempts an hour", () => {
      for (let i = 0; i < 50; i++) {
        expect(refusedBefore("203.0.113.1")).toBeUndefined();
        clock.advance(10 * SECOND);
      }
      // The first attempt was 500 s ago, so a slot frees in 3100 s.
      expect(refusedBefore("203.0.113.1")?.headers["retry-after"]).toBe("3100");
      clock.advance(3100 * SECOND);
      expect(refusedBefore("203.0.113.1")).toBeUndefined();
    });

    it("groups IPv6 by /64 and keeps IPv4 apart", () => {
      for (let i = 0; i < 10; i++) expect(refusedBefore(`2001:db8:1:2::${i + 1}`)).toBeUndefined();
      expect(refusedBefore("2001:db8:1:2:ffff::1")?.status).toBe(429);
      expect(refusedBefore("2001:db8:1:3::1")).toBeUndefined();
    });

    it("records rate-limit.triggered once per key and window, not for each refusal", () => {
      for (let i = 0; i < 10; i++) refusedBefore("203.0.113.1");
      for (let i = 0; i < 5; i++) refusedBefore("203.0.113.1");
      expect(audited("rate-limit.triggered")).toHaveLength(1);
      expect(audited("rate-limit.triggered")[0]).toMatchObject({
        actorKind: "anonymous",
        outcome: "denied",
        ip: "203.0.113.1",
        details: { limit: perIpLimits.perMinute, key: "203.0.113.1" },
      });
      clock.advance(MINUTE);
      for (let i = 0; i < 11; i++) refusedBefore("203.0.113.1");
      expect(audited("rate-limit.triggered")).toHaveLength(2);
    });

    it("reads the limits from the settings", () => {
      services.settings.set("signInLimits", { ...services.settings.get("signInLimits"), perIpPerMinute: 2 }, null);
      expect(refusedBefore("203.0.113.1")).toBeUndefined();
      expect(refusedBefore("203.0.113.1")).toBeUndefined();
      expect(refusedBefore("203.0.113.1")?.status).toBe(429);
    });
  });

  describe("per account and IP", () => {
    it("delays after 5 failures: 1 s, then doubling, capped at 60 s", async () => {
      for (let i = 0; i < 4; i++) expect(await fail()).toBeUndefined();
      const delays: number[] = [];
      for (let i = 0; i < 9; i++) {
        expect(await fail()).toBeUndefined();
        const refusal = await gate.beforePasswordCheck(attempt());
        expect(refusal).toMatchObject({ reason: "delayed", problem: { status: 429, type: problemTypes.tooManyAttempts } });
        const seconds = Number(refusal?.problem.headers["retry-after"]);
        delays.push(seconds);
        clock.advance(seconds * SECOND - 1);
        expect((await gate.beforePasswordCheck(attempt()))?.reason).toBe("delayed");
        clock.advance(1);
      }
      expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
    });

    it("delays only that IP for that account", async () => {
      for (let i = 0; i < 5; i++) await fail();
      expect((await gate.beforePasswordCheck(attempt()))?.reason).toBe("delayed");
      expect(await gate.beforePasswordCheck(attempt("203.0.113.9"))).toBeUndefined();
      const bob = services.accounts.create({ username: "bob", email: "bob@example.com", displayName: "Bob", role: "user" });
      expect(await gate.beforePasswordCheck(attempt("203.0.113.1", bob))).toBeUndefined();
    });

    it("clears the IP's failures on success", async () => {
      for (let i = 0; i < 5; i++) await fail();
      clock.advance(SECOND);
      await gate.recordSuccess({ ...attempt(), account: alice });
      expect(database.db.select().from(signInFailures).all()).toEqual([]);
      for (let i = 0; i < 4; i++) expect(await fail()).toBeUndefined();
      expect(await gate.beforePasswordCheck(attempt())).toBeUndefined();
    });

    it("forgets an IP's failures an hour after the last one", async () => {
      for (let i = 0; i < 5; i++) await fail();
      clock.advance(HOUR);
      await fail();
      expect(database.db.select().from(signInFailures).get()).toMatchObject({ failures: 1, delayedUntil: null });
    });

    it("delays an unknown identifier exactly like an account (T1)", async () => {
      for (let i = 0; i < 5; i++) {
        expect(await fail(undefined, alice)).toBeUndefined();
        expect(await fail(undefined, null)).toBeUndefined();
      }
      const known = await gate.beforePasswordCheck(attempt());
      const unknown = await gate.beforePasswordCheck(attempt(undefined, null));
      expect(known).toMatchObject({ reason: "delayed", problem: { status: 429, headers: { "retry-after": "1" } } });
      expect(unknown).toEqual(known);
    });

    it("counts an unknown identifier as the lookup normalises it, and stores it only as a keyed hash", async () => {
      for (const identifier of ["Mallory", " mallory", "MALLORY ", "mallory", "mallory"]) {
        await gate.recordFailure(attempt(undefined, null, identifier));
      }
      expect((await gate.beforePasswordCheck(attempt(undefined, null, "mallory")))?.reason).toBe("delayed");
      expect(await gate.beforePasswordCheck(attempt(undefined, null, "mallory2"))).toBeUndefined();
      const rows = [...database.db.select().from(signInFailures).all(), ...database.db.select().from(signInLocks).all()];
      expect(rows.map((row) => row.subjectKey)).toEqual([
        `identifier:${testSecrets.mac("sign-in-identifier", "mallory")}`,
        `identifier:${testSecrets.mac("sign-in-identifier", "mallory")}`,
      ]);
      expect(JSON.stringify(rows).toLowerCase()).not.toContain("mallory");
    });
  });

  describe("subjectKeyOf", () => {
    it("is the account when the identifier names one, whichever identifier names it", () => {
      expect(subjectKeyOf(attempt(undefined, alice, "alice@example.com"), testSecrets)).toBe(`account:${alice.id}`);
      expect(subjectKeyOf(attempt(undefined, alice, "alice"), testSecrets)).toBe(`account:${alice.id}`);
    });
  });

  describe("account lock", () => {
    it("locks the account for 15 minutes after 20 failures within an hour from any IP, and records it once", async () => {
      await failFromManyIps(19);
      expect(await gate.beforePasswordCheck(attempt("192.0.2.1"))).toBeUndefined();
      clock.advance(10 * MINUTE);
      await failFromManyIps(1, 19);
      const refusal = await gate.beforePasswordCheck(attempt("192.0.2.1"));
      expect(refusal).toMatchObject({ reason: "locked", problem: { status: 429, headers: { "retry-after": String(15 * 60) } } });
      const lockedUntil = new Date(clock.now().getTime() + 15 * MINUTE).toISOString();
      expect(audited("sign-in.locked")).toMatchObject([
        { actorKind: "system", targetKind: "account", targetId: alice.id, details: { failures: 20, lockedUntil } },
      ]);
      clock.advance(15 * MINUTE - 1);
      expect((await gate.beforePasswordCheck(attempt("192.0.2.1")))?.reason).toBe("locked");
      clock.advance(1);
      expect(await gate.beforePasswordCheck(attempt("192.0.2.1"))).toBeUndefined();
    });

    it("starts a new count once the lock is over, so no lock is permanent", async () => {
      await failFromManyIps(20);
      clock.advance(15 * MINUTE);
      await failFromManyIps(19, 100);
      expect(await gate.beforePasswordCheck(attempt("192.0.2.1"))).toBeUndefined();
      expect(database.db.select().from(signInLocks).get()).toMatchObject({ failures: 19, lockedUntil: null });
      await failFromManyIps(1, 200);
      expect((await gate.beforePasswordCheck(attempt("192.0.2.1")))?.reason).toBe("locked");
      expect(audited("sign-in.locked")).toHaveLength(2);
    });

    it("counts only failures within an hour", async () => {
      await failFromManyIps(19);
      clock.advance(HOUR);
      await failFromManyIps(1, 50);
      expect(await gate.beforePasswordCheck(attempt("192.0.2.1"))).toBeUndefined();
      expect(database.db.select().from(signInLocks).get()).toMatchObject({ failures: 1 });
    });

    it("reads the limits from the settings", async () => {
      services.settings.set("signInLimits", { ...services.settings.get("signInLimits"), lockAfterFailures: 3, lockMinutes: 1 }, null);
      await failFromManyIps(3);
      expect((await gate.beforePasswordCheck(attempt("192.0.2.1")))?.problem.headers["retry-after"]).toBe("60");
    });

    it("locks an unknown identifier exactly like an account, recording it with no target", async () => {
      await failFromManyIps(20, 0, alice);
      await failFromManyIps(20, 0, null);
      const known = await gate.beforePasswordCheck(attempt("192.0.2.1"));
      const unknown = await gate.beforePasswordCheck(attempt("192.0.2.1", null));
      expect(known).toMatchObject({ reason: "locked", problem: { status: 429, headers: { "retry-after": String(15 * 60) } } });
      expect(unknown).toEqual(known);
      expect(audited("sign-in.locked").map((event) => event.targetId ?? null)).toEqual(expect.arrayContaining([alice.id, null]));
    });
  });

  describe("sweepSignInLimits", () => {
    it("keeps rows that still count, and removes them once their window and lock are over", async () => {
      await failFromManyIps(20, 0, null);
      await fail("203.0.113.1", alice);
      expect(storedRows()).toEqual({ failures: 21, locks: 2 });

      clock.advance(HOUR - 1);
      expect(sweepSignInLimits({ db: database.db, clock })).toEqual({ failures: 0, locks: 0 });

      clock.advance(1);
      expect(sweepSignInLimits({ db: database.db, clock })).toEqual({ failures: 21, locks: 2 });
      expect(storedRows()).toEqual({ failures: 0, locks: 0 });
    });

    it("keeps a lock until it ends, even when its window is over", async () => {
      await failFromManyIps(19, 0, alice);
      clock.advance(59 * MINUTE);
      await fail("192.0.2.1", alice);
      expect((await gate.beforePasswordCheck(attempt("192.0.2.2")))?.reason).toBe("locked");
      clock.advance(MINUTE);
      sweepSignInLimits({ db: database.db, clock });
      expect(storedRows().locks).toBe(1);
      expect((await gate.beforePasswordCheck(attempt("192.0.2.2")))?.reason).toBe("locked");
      clock.advance(14 * MINUTE);
      sweepSignInLimits({ db: database.db, clock });
      expect(storedRows().locks).toBe(0);
    });
  });
});
