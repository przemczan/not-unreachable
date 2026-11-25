import type { SessionTimeouts } from "@not-unreachable/contracts";
import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../platform/index.ts";
import { settingsRegistry } from "../settings/index.ts";
import { isSessionLive, LAST_SEEN_WRITE_INTERVAL_MS, PENDING_SESSION_LIFETIME_MS, shouldTouch } from "./index.ts";

const HOUR_MS = 60 * MINUTE_MS;
const start = new Date("2026-11-24T10:00:00.000Z");
const at = (milliseconds: number) => new Date(start.getTime() + milliseconds);
const timeouts: SessionTimeouts = settingsRegistry.sessionTimeouts.default;

function session(overrides: { lastSeenAfter?: number; state?: "active" | "pending_second_factor"; revokedAt?: string | null } = {}) {
  return {
    state: overrides.state ?? "active",
    createdAt: start.toISOString(),
    lastSeenAt: at(overrides.lastSeenAfter ?? 0).toISOString(),
    revokedAt: overrides.revokedAt ?? null,
  } as const;
}

describe("session timeouts", () => {
  it("defaults to 30 min / 12 h for the admin and 2 h / 7 d for a user", () => {
    expect(timeouts).toEqual({ admin: { idleMinutes: 30, absoluteHours: 12 }, user: { idleMinutes: 120, absoluteHours: 168 } });
  });

  it.each([
    ["admin", 30 * MINUTE_MS],
    ["user", 2 * HOUR_MS],
  ] as const)("ends a %s session after its idle time", (role, idle) => {
    expect(isSessionLive(session(), role, timeouts, at(idle - 1))).toBe(true);
    expect(isSessionLive(session(), role, timeouts, at(idle))).toBe(false);
    // Idle counts from the last time it was seen.
    expect(isSessionLive(session({ lastSeenAfter: HOUR_MS }), role, timeouts, at(HOUR_MS + idle - 1))).toBe(true);
  });

  it.each([
    ["admin", 12 * HOUR_MS],
    ["user", 7 * 24 * HOUR_MS],
  ] as const)("ends a %s session at its absolute time, however recently seen", (role, absolute) => {
    expect(isSessionLive(session({ lastSeenAfter: absolute - 2 }), role, timeouts, at(absolute - 1))).toBe(true);
    expect(isSessionLive(session({ lastSeenAfter: absolute - 1 }), role, timeouts, at(absolute))).toBe(false);
  });

  it("ends a pending session 5 minutes after it started, whatever the role's timeouts", () => {
    const pending = session({ state: "pending_second_factor" });
    expect(PENDING_SESSION_LIFETIME_MS).toBe(5 * MINUTE_MS);
    expect(isSessionLive(pending, "user", timeouts, at(5 * MINUTE_MS - 1))).toBe(true);
    expect(isSessionLive(pending, "user", timeouts, at(5 * MINUTE_MS))).toBe(false);
  });

  it("ends a revoked session at once", () => {
    expect(isSessionLive(session({ revokedAt: start.toISOString() }), "admin", timeouts, start)).toBe(false);
  });

  it("follows other settings", () => {
    const short: SessionTimeouts = { admin: { idleMinutes: 5, absoluteHours: 1 }, user: { idleMinutes: 10, absoluteHours: 2 } };
    expect(isSessionLive(session(), "admin", short, at(5 * MINUTE_MS))).toBe(false);
    expect(isSessionLive(session(), "user", short, at(5 * MINUTE_MS))).toBe(true);
    expect(isSessionLive(session({ lastSeenAfter: HOUR_MS }), "admin", short, at(HOUR_MS))).toBe(false);
  });
});

describe("the last_seen_at throttle", () => {
  it("writes at most once a minute", () => {
    const seen = start.toISOString();
    expect(LAST_SEEN_WRITE_INTERVAL_MS).toBe(MINUTE_MS);
    expect(shouldTouch(seen, start)).toBe(false);
    expect(shouldTouch(seen, at(MINUTE_MS - 1))).toBe(false);
    expect(shouldTouch(seen, at(MINUTE_MS))).toBe(true);
    expect(shouldTouch(seen, at(HOUR_MS))).toBe(true);
  });
});
