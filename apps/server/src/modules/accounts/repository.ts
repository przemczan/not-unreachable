import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import { passwordCredentials, setupTokens, users, type SetupTokenRow, type UserRow } from "./schema.ts";

export type UserChange = Partial<Pick<UserRow, "email" | "displayName" | "status" | "disabledAt" | "quotaBytes">>;

export interface AccountsRepository {
  /** Runs `work` in one SQLite transaction; it must not await. */
  transaction<T>(work: () => T): T;

  findUserById(id: string): UserRow | undefined;
  findUserByUsername(username: string): UserRow | undefined;
  findUserByEmail(email: string): UserRow | undefined;
  findAdmin(): UserRow | undefined;
  /** Role `user` only, oldest first. */
  listUsers(): UserRow[];
  insertUser(row: UserRow): void;
  updateUser(id: string, change: UserChange): void;
  /** Answers whether there was one. */
  deleteUser(id: string): boolean;

  findPasswordHash(userId: string): string | undefined;
  /** Inserts or replaces the account's password. */
  savePasswordHash(userId: string, hash: string, at: string): void;
  /** Answers whether there was one. */
  deletePasswordCredential(userId: string): boolean;

  findSetupTokenByHash(tokenHash: string): SetupTokenRow | undefined;
  /** Deletes the unused tokens of the row's purpose, then inserts the row. */
  replaceSetupToken(row: SetupTokenRow): void;
  /** Marks a token used unless it already is; answers whether this call did. */
  markSetupTokenUsed(id: string, at: string): boolean;
}

export function createAccountsRepository(db: Db): AccountsRepository {
  const findUser = (condition: SQL): UserRow | undefined => db.select().from(users).where(condition).get();

  return {
    transaction: (work) => db.transaction(() => work()),

    findUserById: (id) => findUser(eq(users.id, id)),
    findUserByUsername: (username) => findUser(eq(users.username, username)),
    findUserByEmail: (email) => findUser(eq(users.email, email)),
    findAdmin: () => findUser(eq(users.role, "admin")),
    listUsers: () => db.select().from(users).where(eq(users.role, "user")).orderBy(asc(users.createdAt), asc(users.id)).all(),
    insertUser(row) {
      db.insert(users).values(row).run();
    },
    updateUser(id, change) {
      db.update(users).set(change).where(eq(users.id, id)).run();
    },
    deleteUser: (id) => db.delete(users).where(eq(users.id, id)).run().changes > 0,

    findPasswordHash(userId) {
      return db.select({ hash: passwordCredentials.hash }).from(passwordCredentials).where(eq(passwordCredentials.userId, userId)).get()
        ?.hash;
    },
    savePasswordHash(userId, hash, at) {
      db.insert(passwordCredentials)
        .values({ userId, hash, createdAt: at, updatedAt: at })
        .onConflictDoUpdate({ target: passwordCredentials.userId, set: { hash, updatedAt: at } })
        .run();
    },
    deletePasswordCredential(userId) {
      return db.delete(passwordCredentials).where(eq(passwordCredentials.userId, userId)).run().changes > 0;
    },

    findSetupTokenByHash(tokenHash) {
      return db.select().from(setupTokens).where(eq(setupTokens.tokenHash, tokenHash)).get();
    },
    replaceSetupToken(row) {
      db.transaction(() => {
        db.delete(setupTokens)
          .where(and(eq(setupTokens.purpose, row.purpose), isNull(setupTokens.usedAt)))
          .run();
        db.insert(setupTokens).values(row).run();
      });
    },
    markSetupTokenUsed(id, at) {
      return (
        db
          .update(setupTokens)
          .set({ usedAt: at })
          .where(and(eq(setupTokens.id, id), isNull(setupTokens.usedAt)))
          .run().changes === 1
      );
    },
  };
}
