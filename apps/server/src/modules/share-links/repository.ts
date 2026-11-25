import { shareLinkAccesses, shareLinkKinds, type Role, type ShareLinkAllowedUser, type ShareLinkState } from "@not-unreachable/contracts";
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { users } from "../accounts/index.ts";
import type { Db } from "../platform/index.ts";
import {
  shareLinks,
  shareLinkUnlocks,
  shareLinkUsers,
  storedShareLinkAccesses,
  storedShareLinkKinds,
  type NewShareLinkRow,
  type ShareLinkRow,
} from "./schema.ts";

/** The schema's literals must be the contracts' exactly (both ways), or this file doesn't compile. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameLists: [
  Same<(typeof storedShareLinkKinds)[number], (typeof shareLinkKinds)[number]>,
  Same<(typeof storedShareLinkAccesses)[number], (typeof shareLinkAccesses)[number]>,
] = [true, true];
void sameLists;

export type ShareLinkChange = Partial<Pick<ShareLinkRow, "expiresAt" | "passwordHash" | "access">>;

/** Where a page of the list starts: after this link, newest first. */
export interface ShareLinksPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface ShareLinksRepository {
  /** Runs `work` in one SQLite transaction; it must not await. */
  transaction<T>(work: () => T): T;

  insert(row: NewShareLinkRow): void;
  findById(id: string): ShareLinkRow | undefined;
  findByTokenHash(tokenHash: string): ShareLinkRow | undefined;
  /** Newest first, in the state at `now`, after `after`; at most `limit`. */
  list(
    filter: { readonly state: ShareLinkState | undefined; readonly now: string },
    after: ShareLinksPosition | undefined,
    limit: number,
  ): ShareLinkRow[];
  /**
   * The links active at `now` that this user can open: every "Signed-in users" link and every
   * "Selected users" link that lists them. Newest first, after `after`; at most `limit`.
   */
  listSharedWith(userId: string, now: string, after: ShareLinksPosition | undefined, limit: number): ShareLinkRow[];
  /** Changes a link that isn't revoked; answers whether it did. */
  change(id: string, change: ShareLinkChange): boolean;
  /** Revokes the link unless it is revoked already; answers whether this call did. */
  revoke(id: string, at: string): boolean;
  /** Locks the link until `until`, unless it is locked until later already. */
  lock(id: string, until: string): void;
  /** One more download, used at `at`. */
  countDownload(id: string, at: string): void;

  /** The users each link was shared with, by link id, each list ordered by username; a link with none has no entry. */
  allowedUsers(shareLinkIds: readonly string[]): Map<string, ShareLinkAllowedUser[]>;
  /** Replaces the users the link was shared with; call it in the transaction that writes the link. */
  replaceAllowedUsers(shareLinkId: string, userIds: readonly string[]): void;
  /** Whether the link was shared with this user. */
  isAllowed(shareLinkId: string, userId: string): boolean;
  /** The roles of the accounts with these ids; an unknown id has no entry. */
  rolesOf(userIds: readonly string[]): Map<string, Role>;

  insertUnlock(row: { readonly id: string; readonly shareLinkId: string; readonly unlockHash: string; readonly expiresAt: string }): void;
  /** Whether the link has this unlock and it is still valid at `now`. */
  hasUnlock(shareLinkId: string, unlockHash: string, now: string): boolean;
  /** Deletes every unlock of the link. */
  deleteUnlocks(shareLinkId: string): number;
  /** Deletes the unlocks expired at `now`; answers how many. */
  purgeExpiredUnlocks(now: string): number;
}

/** The SQL condition of each state at `now`, as {@link stateOf} reads a row. */
const stateConditions: Readonly<Record<ShareLinkState, (now: string) => SQL | undefined>> = {
  revoked: () => isNotNull(shareLinks.revokedAt),
  expired: (now) => and(isNull(shareLinks.revokedAt), isNotNull(shareLinks.expiresAt), lte(shareLinks.expiresAt, now)),
  active: (now) => and(isNull(shareLinks.revokedAt), or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now))),
};

/** Links after `after` in the lists' order, newest first. */
const afterPosition = (after: ShareLinksPosition | undefined): SQL | undefined =>
  after === undefined
    ? undefined
    : or(lt(shareLinks.createdAt, after.createdAt), and(eq(shareLinks.createdAt, after.createdAt), lt(shareLinks.id, after.id)));

export function createShareLinksRepository(db: Db): ShareLinksRepository {
  /** Links that list this user, by `share_link_users`' primary key. */
  const listsUser = (userId: string): SQL =>
    exists(
      db
        .select({ userId: shareLinkUsers.userId })
        .from(shareLinkUsers)
        .where(and(eq(shareLinkUsers.shareLinkId, shareLinks.id), eq(shareLinkUsers.userId, userId))),
    );

  return {
    transaction: (work) => db.transaction(() => work()),

    insert(row) {
      db.insert(shareLinks).values(row).run();
    },
    findById: (id) => db.select().from(shareLinks).where(eq(shareLinks.id, id)).get(),
    findByTokenHash: (tokenHash) => db.select().from(shareLinks).where(eq(shareLinks.tokenHash, tokenHash)).get(),
    list: ({ state, now }, after, limit) =>
      db
        .select()
        .from(shareLinks)
        .where(and(state === undefined ? undefined : stateConditions[state](now), afterPosition(after)))
        .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id))
        .limit(limit)
        .all(),
    listSharedWith: (userId, now, after, limit) =>
      db
        .select()
        .from(shareLinks)
        .where(
          and(
            stateConditions.active(now),
            or(eq(shareLinks.access, "signed-in"), and(eq(shareLinks.access, "selected-users"), listsUser(userId))),
            afterPosition(after),
          ),
        )
        .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id))
        .limit(limit)
        .all(),
    change: (id, change) =>
      db
        .update(shareLinks)
        .set(change)
        .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)))
        .run().changes === 1,
    revoke: (id, at) =>
      db
        .update(shareLinks)
        .set({ revokedAt: at })
        .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)))
        .run().changes === 1,
    lock(id, until) {
      db.update(shareLinks)
        .set({ lockedUntil: until })
        .where(and(eq(shareLinks.id, id), or(isNull(shareLinks.lockedUntil), lt(shareLinks.lockedUntil, until))))
        .run();
    },
    countDownload(id, at) {
      db.update(shareLinks)
        .set({ downloadCount: sql`${shareLinks.downloadCount} + 1`, lastUsedAt: at })
        .where(eq(shareLinks.id, id))
        .run();
    },

    allowedUsers(shareLinkIds) {
      const lists = new Map<string, ShareLinkAllowedUser[]>();
      if (shareLinkIds.length === 0) return lists;
      const rows = db
        .select({ shareLinkId: shareLinkUsers.shareLinkId, id: users.id, username: users.username, displayName: users.displayName })
        .from(shareLinkUsers)
        .innerJoin(users, eq(users.id, shareLinkUsers.userId))
        .where(inArray(shareLinkUsers.shareLinkId, [...shareLinkIds]))
        .orderBy(asc(users.username))
        .all();
      for (const { shareLinkId, ...user } of rows) {
        const list = lists.get(shareLinkId);
        if (list === undefined) lists.set(shareLinkId, [user]);
        else list.push(user);
      }
      return lists;
    },
    replaceAllowedUsers(shareLinkId, userIds) {
      db.delete(shareLinkUsers).where(eq(shareLinkUsers.shareLinkId, shareLinkId)).run();
      if (userIds.length > 0)
        db.insert(shareLinkUsers)
          .values(userIds.map((userId) => ({ shareLinkId, userId })))
          .run();
    },
    isAllowed: (shareLinkId, userId) =>
      db
        .select({ userId: shareLinkUsers.userId })
        .from(shareLinkUsers)
        .where(and(eq(shareLinkUsers.shareLinkId, shareLinkId), eq(shareLinkUsers.userId, userId)))
        .get() !== undefined,
    rolesOf: (userIds) =>
      new Map(
        userIds.length === 0
          ? []
          : db
              .select({ id: users.id, role: users.role })
              .from(users)
              .where(inArray(users.id, [...userIds]))
              .all()
              .map((row) => [row.id, row.role] as const),
      ),

    insertUnlock(row) {
      db.insert(shareLinkUnlocks).values(row).run();
    },
    hasUnlock: (shareLinkId, unlockHash, now) =>
      db
        .select({ id: shareLinkUnlocks.id })
        .from(shareLinkUnlocks)
        .where(
          and(
            eq(shareLinkUnlocks.shareLinkId, shareLinkId),
            eq(shareLinkUnlocks.unlockHash, unlockHash),
            gt(shareLinkUnlocks.expiresAt, now),
          ),
        )
        .get() !== undefined,
    deleteUnlocks: (shareLinkId) => db.delete(shareLinkUnlocks).where(eq(shareLinkUnlocks.shareLinkId, shareLinkId)).run().changes,
    purgeExpiredUnlocks: (now) => db.delete(shareLinkUnlocks).where(lte(shareLinkUnlocks.expiresAt, now)).run().changes,
  };
}
