import {
  auditEventSchema,
  type AuditAction,
  type AuditEvent,
  type AuditFilter,
  type AuditPage,
  type auditPageQuerySchema,
} from "@not-unreachable/contracts";
import { z } from "zod";
import { DAY_MS, newId, type Clock, type Logger } from "../platform/index.ts";
import type { SettingsService } from "../settings/index.ts";
import { toCsv } from "./csv.ts";
import { auditDetailsSchemas, type AuditEventInput } from "./events.ts";
import type { AuditPosition, AuditRepository, AuditRowFilter, UploaderRow } from "./repository.ts";
import type { AuditEventRow } from "./schema.ts";

export const USER_AGENT_MAX_CHARACTERS = 256;
/** The most rows one CSV export holds; narrower filters reach older events. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

export const auditCsvHeader = [
  "at",
  "actor kind",
  "actor username",
  "actor account id",
  "action",
  "target kind",
  "target id",
  "outcome",
  "ip",
  "user agent",
  "details",
] as const;

/** Thrown by `list` for a cursor it didn't make; the route answers 400. */
export class InvalidAuditCursorError extends Error {
  override readonly name = "InvalidAuditCursorError";

  constructor() {
    super("The audit cursor is not valid");
  }
}

export type AuditPageQuery = z.output<typeof auditPageQuerySchema>;

export interface AuditService {
  /** Validates the details (throws on invalid: a programmer error), stores the event and logs a copy. */
  record<Action extends AuditAction>(event: AuditEventInput<Action>): void;
  /** Newest first; throws {@link InvalidAuditCursorError}. */
  list(query: AuditPageQuery): AuditPage;
  /** The events matching `filter`, newest first, as CSV with a header row. */
  exportCsv(filter: AuditFilter): string;
  /** Deletes events older than the retention setting and records `audit.purged`; answers how many. */
  purgeExpired(): number;
  /**
   * The accounts that uploaded files themselves at or after `since` (successful `file.uploaded`
   * events they are the actor of), with how many and when the last was, last upload newest first.
   */
  uploadersSince(since: Date): UploaderRow[];
}

const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

function encodeCursor(row: AuditEventRow): string {
  return Buffer.from(JSON.stringify([row.at, row.id])).toString("base64url");
}

function decodeCursor(cursor: string): AuditPosition {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidAuditCursorError();
  }
  const result = cursorSchema.safeParse(decoded);
  if (!result.success) throw new InvalidAuditCursorError();
  const [at, id] = result.data;
  return { at: new Date(at).toISOString(), id };
}

/** Stored times are `toISOString()` strings, so a filter's time is too before it's compared as text. */
function rowFilter(filter: AuditFilter): AuditRowFilter {
  return {
    from: filter.from === undefined ? undefined : new Date(filter.from).toISOString(),
    to: filter.to === undefined ? undefined : new Date(filter.to).toISOString(),
    actorKind: filter.actorKind,
    actorUsername: filter.actorUsername,
    action: filter.action,
    outcome: filter.outcome,
  };
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return auditEventSchema.parse({ ...row, details: JSON.parse(row.details) });
}

function firstCharacters(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

export function createAuditServiceWith(repository: AuditRepository, clock: Clock, logger: Logger, settings: SettingsService): AuditService {
  const service: AuditService = {
    record(event) {
      const details = auditDetailsSchemas[event.action].parse(event.details);
      const now = clock.now();
      const row: AuditEventRow = {
        id: newId({ now: () => now }),
        at: now.toISOString(),
        actorKind: event.actor.kind,
        actorAccountId: event.actor.kind === "account" ? event.actor.accountId : null,
        actorUsername: event.actor.kind === "account" ? event.actor.username : null,
        action: event.action,
        targetKind: event.target?.kind ?? null,
        targetId: event.target?.id ?? null,
        outcome: event.outcome,
        ip: event.origin?.ip ?? null,
        userAgent: event.origin?.userAgent == null ? null : firstCharacters(event.origin.userAgent, USER_AGENT_MAX_CHARACTERS),
        details: JSON.stringify(details),
      };
      repository.insert(row);
      // A copy on the host, which an admin of the app can't remove (threat model, T12).
      logger.info({ audit: { ...row, details } }, "Audit event");
    },

    list(query) {
      const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const rows = repository.page(rowFilter(query), after, query.limit + 1);
      const events = rows.slice(0, query.limit);
      const last = events.at(-1);
      return {
        events: events.map(toAuditEvent),
        nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor(last) : null,
      };
    },

    exportCsv(filter) {
      const rows = repository.all(rowFilter(filter), AUDIT_EXPORT_MAX_ROWS);
      if (rows.length === AUDIT_EXPORT_MAX_ROWS) logger.warn({ rows: rows.length }, "Audit export reached its row limit");
      return toCsv([
        auditCsvHeader,
        ...rows.map((row) => [
          row.at,
          row.actorKind,
          row.actorUsername,
          row.actorAccountId,
          row.action,
          row.targetKind,
          row.targetId,
          row.outcome,
          row.ip,
          row.userAgent,
          row.details,
        ]),
      ]);
    },

    purgeExpired() {
      const before = new Date(clock.now().getTime() - settings.get("auditRetentionDays") * DAY_MS).toISOString();
      const count = repository.deleteBefore(before);
      service.record({ action: "audit.purged", actor: { kind: "system" }, outcome: "succeeded", details: { count, before } });
      return count;
    },

    uploadersSince(since) {
      return repository.uploadersSince(since.toISOString());
    },
  };
  return service;
}
