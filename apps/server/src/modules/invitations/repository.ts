import { and, desc, eq, gt, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import { invitations, reservedUsernames, type InvitationRow, type ReservedUsernameRow } from "./schema.ts";

export interface InvitationsRepository {
  /** Runs `work` in one SQLite transaction; it must not await. Other modules' calls inside it join it (one connection). */
  transaction<T>(work: () => T): T;

  insert(row: InvitationRow): void;
  findById(id: string): InvitationRow | undefined;
  findByTokenHash(tokenHash: string): InvitationRow | undefined;
  /** Kind `invite`, newest first. */
  listInvites(): InvitationRow[];
  /** Revokes the link while it is pending at `at`; answers whether this call did. */
  revoke(id: string, at: string): boolean;
  /** Revokes the user's re-link links still pending at `at`; answers how many. */
  revokePendingRelinks(userId: string, at: string): number;
  /**
   * Uses the link while it is still pending at `at`, in one conditional UPDATE: of two callers,
   * only one ever gets true (threat model, T1: single use).
   */
  claim(id: string, at: string, acceptedUserId: string | null): boolean;
  setAcceptedUser(id: string, userId: string): void;

  findReservation(username: string): ReservedUsernameRow | undefined;
  /** Keeps an existing reservation as it is. */
  reserve(username: string, at: string): void;
  dropReservation(username: string): void;
}

/** Neither used nor revoked, and not expired at `at`. */
const pendingAt = (at: string): SQL | undefined =>
  and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, at));

export function createInvitationsRepository(db: Db): InvitationsRepository {
  return {
    transaction: (work) => db.transaction(() => work()),

    insert(row) {
      db.insert(invitations).values(row).run();
    },
    findById: (id) => db.select().from(invitations).where(eq(invitations.id, id)).get(),
    findByTokenHash: (tokenHash) => db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).get(),
    listInvites: () =>
      db.select().from(invitations).where(eq(invitations.kind, "invite")).orderBy(desc(invitations.createdAt), desc(invitations.id)).all(),
    revoke: (id, at) =>
      db
        .update(invitations)
        .set({ revokedAt: at })
        .where(and(eq(invitations.id, id), pendingAt(at)))
        .run().changes === 1,
    revokePendingRelinks: (userId, at) =>
      db
        .update(invitations)
        .set({ revokedAt: at })
        .where(and(eq(invitations.kind, "relink"), eq(invitations.targetUserId, userId), pendingAt(at)))
        .run().changes,
    claim: (id, at, acceptedUserId) =>
      db
        .update(invitations)
        .set({ acceptedAt: at, acceptedUserId })
        .where(and(eq(invitations.id, id), pendingAt(at)))
        .run().changes === 1,
    setAcceptedUser(id, userId) {
      db.update(invitations).set({ acceptedUserId: userId }).where(eq(invitations.id, id)).run();
    },

    findReservation: (username) => db.select().from(reservedUsernames).where(eq(reservedUsernames.username, username)).get(),
    reserve(username, at) {
      db.insert(reservedUsernames).values({ username, createdAt: at }).onConflictDoNothing({ target: reservedUsernames.username }).run();
    },
    dropReservation(username) {
      db.delete(reservedUsernames).where(eq(reservedUsernames.username, username)).run();
    },
  };
}
