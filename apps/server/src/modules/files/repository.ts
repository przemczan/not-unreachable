import { uploadConflictChoices } from "@not-unreachable/contracts";
import { and, count, eq, gt, isNotNull, lte, ne, sum } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import { storedConflictChoices, uploads, type NewUploadRow, type UploadRow } from "./schema.ts";

/** The schema's literals must be the contracts' exactly (both ways), or this file doesn't compile. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameLists: [Same<(typeof storedConflictChoices)[number], (typeof uploadConflictChoices)[number]>] = [true];
void sameLists;

export type UploadRowChange = Partial<Pick<UploadRow, "offset" | "lastChunkAt" | "expiresAt" | "tempName" | "completedAt">>;

export interface UploadsRepository {
  find(id: string): UploadRow | undefined;
  insert(row: NewUploadRow): void;
  update(id: string, change: UploadRowChange): void;
  delete(id: string): void;
  /** Every row's id, live or expired. */
  listIds(): string[];
  /** Unfinished uploads that haven't expired at `now`: the account's, or the whole instance's. */
  countLive(now: string, accountId?: string): number;
  /** The declared bytes of the account's live uploads, but `exceptId`'s. */
  liveBytes(accountId: string, now: string, exceptId?: string): number;
  /** Rows that expired at `now` or before. */
  listExpired(now: string): UploadRow[];
  /** Rows with a temporary file in their target whose last chunk came at `before` or earlier. */
  listStaleTemps(before: string): UploadRow[];
}

export function createUploadsRepository(db: Db): UploadsRepository {
  return {
    find: (id) => db.select().from(uploads).where(eq(uploads.id, id)).get(),
    insert(row) {
      db.insert(uploads).values(row).run();
    },
    update(id, change) {
      db.update(uploads).set(change).where(eq(uploads.id, id)).run();
    },
    delete(id) {
      db.delete(uploads).where(eq(uploads.id, id)).run();
    },
    listIds: () =>
      db
        .select({ id: uploads.id })
        .from(uploads)
        .all()
        .map((row) => row.id),
    countLive(now, accountId) {
      const live = gt(uploads.expiresAt, now);
      const row = db
        .select({ value: count() })
        .from(uploads)
        .where(accountId === undefined ? live : and(live, eq(uploads.accountId, accountId)))
        .get();
      return row?.value ?? 0;
    },
    liveBytes(accountId, now, exceptId) {
      const conditions = [eq(uploads.accountId, accountId), gt(uploads.expiresAt, now)];
      if (exceptId !== undefined) conditions.push(ne(uploads.id, exceptId));
      const row = db
        .select({ value: sum(uploads.size) })
        .from(uploads)
        .where(and(...conditions))
        .get();
      return Number(row?.value ?? 0);
    },
    listExpired: (now) => db.select().from(uploads).where(lte(uploads.expiresAt, now)).all(),
    listStaleTemps: (before) =>
      db
        .select()
        .from(uploads)
        .where(and(isNotNull(uploads.tempName), lte(uploads.lastChunkAt, before)))
        .all(),
  };
}
