import type { Role, SessionTimeouts } from "@not-unreachable/contracts";
import { MINUTE_MS } from "../platform/index.ts";
import type { SessionRow } from "./schema.ts";

const HOUR_MS = 60 * MINUTE_MS;

/** A session still waiting for its second factor lives this long (threat model, T2). */
export const PENDING_SESSION_LIFETIME_MS = 5 * MINUTE_MS;

/** `last_seen_at` is written at most this often. */
export const LAST_SEEN_WRITE_INTERVAL_MS = MINUTE_MS;

type SessionTimes = Pick<SessionRow, "state" | "createdAt" | "lastSeenAt" | "revokedAt">;

/**
 * Whether a session is still usable at `now`: not revoked, and within its timeouts. A pending
 * session lives 5 minutes from its start; an active one ends after the role's idle time since
 * `last_seen_at` or its absolute time since sign-in, whichever comes first.
 */
export function isSessionLive(session: SessionTimes, role: Role, timeouts: SessionTimeouts, now: Date): boolean {
  if (session.revokedAt !== null) return false;
  const time = now.getTime();
  const started = new Date(session.createdAt).getTime();
  if (session.state === "pending_second_factor") return time - started < PENDING_SESSION_LIFETIME_MS;
  const limits = timeouts[role];
  const idle = time - new Date(session.lastSeenAt).getTime();
  return idle < limits.idleMinutes * MINUTE_MS && time - started < limits.absoluteHours * HOUR_MS;
}

/** Whether a request at `now` should write `last_seen_at`: at most once a minute. */
export function shouldTouch(lastSeenAt: string, now: Date): boolean {
  return now.getTime() - new Date(lastSeenAt).getTime() >= LAST_SEEN_WRITE_INTERVAL_MS;
}
