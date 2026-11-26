import { and, count, desc, eq, gte, isNotNull, lt, max, or, type SQL } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import { auditEvents, type AuditEventRow } from "./schema.ts";

/** The filters as the repository applies them; times are normalised ISO strings, as stored. */
export interface AuditRowFilter {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly actorKind?: AuditEventRow["actorKind"] | undefined;
  readonly actorUsername?: string | undefined;
  readonly action?: string | undefined;
  readonly outcome?: AuditEventRow["outcome"] | undefined;
}

/** Where the previous page ended: its last row's time and id. */
export interface AuditPosition {
  readonly at: string;
  readonly id: string;
}

/** One account's successful uploads since a time: how many, and when the last one was. */
export interface UploaderRow {
  readonly accountId: string;
  readonly uploads: number;
  readonly lastUploadAt: string;
}

export interface AuditRepository {
  insert(row: AuditEventRow): void;
  /** Accounts' own successful `file.uploaded` events at or after `since`, grouped by account, last upload newest first. */
  uploadersSince(since: string): UploaderRow[];
  /** Newest first (`at`, then `id`, descending), after `after` when given. */
  page(filter: AuditRowFilter, after: AuditPosition | undefined, limit: number): AuditEventRow[];
  /** Newest first, at most `limit`. */
  all(filter: AuditRowFilter, limit: number): AuditEventRow[];
  /** Deletes events before `before`; answers how many. */
  deleteBefore(before: string): number;
}

function conditions(filter: AuditRowFilter): SQL[] {
  const result: SQL[] = [];
  if (filter.from !== undefined) result.push(gte(auditEvents.at, filter.from));
  if (filter.to !== undefined) result.push(lt(auditEvents.at, filter.to));
  if (filter.actorKind !== undefined) result.push(eq(auditEvents.actorKind, filter.actorKind));
  if (filter.actorUsername !== undefined) result.push(eq(auditEvents.actorUsername, filter.actorUsername));
  if (filter.action !== undefined) result.push(eq(auditEvents.action, filter.action));
  if (filter.outcome !== undefined) result.push(eq(auditEvents.outcome, filter.outcome));
  return result;
}

function before(position: AuditPosition): SQL | undefined {
  return or(lt(auditEvents.at, position.at), and(eq(auditEvents.at, position.at), lt(auditEvents.id, position.id)));
}

export function createAuditRepository(db: Db): AuditRepository {
  const newestFirst = (where: SQL[], limit: number): AuditEventRow[] =>
    db
      .select()
      .from(auditEvents)
      .where(and(...where))
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(limit)
      .all();

  return {
    insert(row) {
      db.insert(auditEvents).values(row).run();
    },
    uploadersSince(since) {
      const lastUploadAt = max(auditEvents.at);
      const rows = db
        .select({ accountId: auditEvents.actorAccountId, uploads: count(), lastUploadAt })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "file.uploaded"),
            gte(auditEvents.at, since),
            eq(auditEvents.outcome, "succeeded"),
            eq(auditEvents.actorKind, "account"),
            isNotNull(auditEvents.actorAccountId),
          ),
        )
        .groupBy(auditEvents.actorAccountId)
        .orderBy(desc(lastUploadAt), auditEvents.actorAccountId)
        .all();
      return rows.flatMap(({ accountId, uploads, lastUploadAt: last }) =>
        accountId === null || last === null ? [] : [{ accountId, uploads, lastUploadAt: last }],
      );
    },
    page(filter, after, limit) {
      const where = conditions(filter);
      const afterCondition = after === undefined ? undefined : before(after);
      if (afterCondition !== undefined) where.push(afterCondition);
      return newestFirst(where, limit);
    },
    all(filter, limit) {
      return newestFirst(conditions(filter), limit);
    },
    deleteBefore(time) {
      return db.delete(auditEvents).where(lt(auditEvents.at, time)).run().changes;
    },
  };
}
