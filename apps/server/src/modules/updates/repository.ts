import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import { UPDATE_CHECK_ID, updateChecks, updateRequests, type UpdateCheckRow, type UpdateRequestRow } from "./schema.ts";

export interface UpdatesRepository {
  /** Runs `work` in one SQLite transaction; it must not await. */
  transaction<T>(work: () => T): T;
  /** The kept check, once the server first asked. */
  findCheck(): UpdateCheckRow | undefined;
  /** GitHub answered: keeps the release (JSON) and forgets an earlier failure. */
  saveAnswer(release: string, checkedAt: string): void;
  /** A check failed: keeps the last good answer. */
  saveFailure(failedAt: string): void;
  insertRequest(row: UpdateRequestRow): void;
  /** The newest request. */
  latestRequest(): UpdateRequestRow | undefined;
  /** Requests whose `update.finished` isn't recorded yet. */
  unrecordedRequests(): UpdateRequestRow[];
  markHandedOver(requestId: string, at: string): void;
  /** The server's own end of a request (`refused` and its reason). */
  finishOnServer(requestId: string, result: string, reason: string, at: string): void;
  /** Claims the right to record `update.finished`: true for exactly one caller per request. */
  claimRecording(requestId: string, at: string): boolean;
}

export function createUpdatesRepository(db: Db): UpdatesRepository {
  return {
    transaction: (work) => db.transaction(() => work()),
    findCheck() {
      return db.select().from(updateChecks).where(eq(updateChecks.id, UPDATE_CHECK_ID)).get();
    },
    saveAnswer(release, checkedAt) {
      const row = { id: UPDATE_CHECK_ID, release, checkedAt, failedAt: null };
      db.insert(updateChecks).values(row).onConflictDoUpdate({ target: updateChecks.id, set: row }).run();
    },
    saveFailure(failedAt) {
      db.insert(updateChecks)
        .values({ id: UPDATE_CHECK_ID, release: null, checkedAt: null, failedAt })
        .onConflictDoUpdate({ target: updateChecks.id, set: { failedAt } })
        .run();
    },
    insertRequest(row) {
      db.insert(updateRequests).values(row).run();
    },
    latestRequest() {
      return db
        .select()
        .from(updateRequests)
        .orderBy(desc(sql`rowid`))
        .limit(1)
        .get();
    },
    unrecordedRequests() {
      return db
        .select()
        .from(updateRequests)
        .where(isNull(updateRequests.recordedAt))
        .orderBy(sql`rowid`)
        .all();
    },
    markHandedOver(requestId, at) {
      db.update(updateRequests).set({ handedOverAt: at }).where(eq(updateRequests.requestId, requestId)).run();
    },
    finishOnServer(requestId, result, reason, at) {
      db.update(updateRequests)
        .set({ result, reason, finishedAt: at })
        .where(and(eq(updateRequests.requestId, requestId), isNull(updateRequests.result)))
        .run();
    },
    claimRecording(requestId, at) {
      // One conditional update: two servers, or two readers in one, can't both win.
      const claimed = db
        .update(updateRequests)
        .set({ recordedAt: at })
        .where(and(eq(updateRequests.requestId, requestId), isNull(updateRequests.recordedAt)))
        .run();
      return claimed.changes === 1;
    },
  };
}
