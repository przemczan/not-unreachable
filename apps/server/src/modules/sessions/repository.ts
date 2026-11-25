import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import { sessions, type SessionRow } from "./schema.ts";

export type SessionChange = Partial<Pick<SessionRow, "tokenHash" | "lastSeenAt" | "recentSignInAt" | "state">>;

export interface SessionsRepository {
  insert(row: SessionRow): void;
  findByTokenHash(tokenHash: string): SessionRow | undefined;
  findById(id: string): SessionRow | undefined;
  /** The account's sessions not revoked yet, some of them maybe timed out. */
  listUnrevoked(userId: string): SessionRow[];
  update(id: string, change: SessionChange): void;
  /** Revokes the session unless it already is; answers whether this call did. */
  revoke(id: string, at: string): boolean;
}

export function createSessionsRepository(db: Db): SessionsRepository {
  return {
    insert(row) {
      db.insert(sessions).values(row).run();
    },
    findByTokenHash(tokenHash) {
      return db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get();
    },
    findById(id) {
      return db.select().from(sessions).where(eq(sessions.id, id)).get();
    },
    listUnrevoked(userId) {
      return db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .orderBy(sessions.createdAt)
        .all();
    },
    update(id, change) {
      db.update(sessions).set(change).where(eq(sessions.id, id)).run();
    },
    revoke(id, at) {
      return (
        db
          .update(sessions)
          .set({ revokedAt: at })
          .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
          .run().changes === 1
      );
    },
  };
}
