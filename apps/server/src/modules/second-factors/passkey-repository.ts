import { and, asc, desc, eq, gt, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import {
  passkeyCredentials,
  webAuthnChallenges,
  type PasskeyCredentialRow,
  type WebAuthnChallengePurpose,
  type WebAuthnChallengeRow,
} from "./schema.ts";

/** Whom a challenge is bound to: a session, or a browser's `__Host-nu_webauthn` cookie by its hash. */
export type ChallengeBinding =
  { readonly sessionId: string; readonly browserTokenHash?: never } | { readonly browserTokenHash: string; readonly sessionId?: never };

export type NewChallenge = Omit<WebAuthnChallengeRow, "sessionId" | "browserTokenHash" | "usedAt"> & {
  readonly binding: ChallengeBinding;
};

export interface PasskeysRepository {
  insertPasskey(row: PasskeyCredentialRow): void;
  findPasskey(userId: string, id: string): PasskeyCredentialRow | undefined;
  findByCredentialId(credentialId: string): PasskeyCredentialRow | undefined;
  listPasskeys(userId: string): PasskeyCredentialRow[];
  renamePasskey(id: string, name: string): void;
  /**
   * Stores a use: the new counter only if it is above the stored one (or both are 0, for
   * authenticators that keep none), so two requests can't both pass with one count; answers whether it did.
   */
  usePasskey(id: string, counter: number, backedUp: boolean, at: string): boolean;
  deletePasskey(id: string): void;
  deleteAllPasskeys(userId: string): number;
  /** Stores a challenge, voiding every unused one of the same purpose and binding. */
  replaceChallenge(challenge: NewChallenge): void;
  /** Uses up the binding's newest live challenge of `purpose`; answers it, or undefined when there is none. */
  takeChallenge(purpose: WebAuthnChallengePurpose, binding: ChallengeBinding, now: string): string | undefined;
  /** Deletes challenges that are used or void since before `at`. */
  deleteChallengesBefore(at: string): number;
}

const bindingCondition = (binding: ChallengeBinding) =>
  binding.sessionId === undefined
    ? eq(webAuthnChallenges.browserTokenHash, binding.browserTokenHash)
    : eq(webAuthnChallenges.sessionId, binding.sessionId);

export function createPasskeysRepository(db: Db): PasskeysRepository {
  return {
    insertPasskey(row) {
      db.insert(passkeyCredentials).values(row).run();
    },
    findPasskey(userId, id) {
      return db
        .select()
        .from(passkeyCredentials)
        .where(and(eq(passkeyCredentials.userId, userId), eq(passkeyCredentials.id, id)))
        .get();
    },
    findByCredentialId(credentialId) {
      return db.select().from(passkeyCredentials).where(eq(passkeyCredentials.credentialId, credentialId)).get();
    },
    listPasskeys(userId) {
      return db
        .select()
        .from(passkeyCredentials)
        .where(eq(passkeyCredentials.userId, userId))
        .orderBy(asc(passkeyCredentials.createdAt))
        .all();
    },
    renamePasskey(id, name) {
      db.update(passkeyCredentials).set({ name }).where(eq(passkeyCredentials.id, id)).run();
    },
    usePasskey(id, counter, backedUp, at) {
      return (
        db
          .update(passkeyCredentials)
          .set({ counter, backedUp, lastUsedAt: at })
          .where(
            and(eq(passkeyCredentials.id, id), counter === 0 ? eq(passkeyCredentials.counter, 0) : lt(passkeyCredentials.counter, counter)),
          )
          .run().changes === 1
      );
    },
    deletePasskey(id) {
      db.delete(passkeyCredentials).where(eq(passkeyCredentials.id, id)).run();
    },
    deleteAllPasskeys(userId) {
      return db.delete(passkeyCredentials).where(eq(passkeyCredentials.userId, userId)).run().changes;
    },
    replaceChallenge({ binding, ...challenge }) {
      db.transaction((tx) => {
        tx.update(webAuthnChallenges)
          .set({ usedAt: challenge.createdAt })
          .where(and(eq(webAuthnChallenges.purpose, challenge.purpose), bindingCondition(binding), isNull(webAuthnChallenges.usedAt)))
          .run();
        tx.insert(webAuthnChallenges)
          .values({
            ...challenge,
            sessionId: binding.sessionId ?? null,
            browserTokenHash: binding.browserTokenHash ?? null,
            usedAt: null,
          })
          .run();
      });
    },
    takeChallenge(purpose, binding, now) {
      return db.transaction((tx) => {
        const row = tx
          .select()
          .from(webAuthnChallenges)
          .where(
            and(
              eq(webAuthnChallenges.purpose, purpose),
              bindingCondition(binding),
              isNull(webAuthnChallenges.usedAt),
              gt(webAuthnChallenges.expiresAt, now),
            ),
          )
          .orderBy(desc(webAuthnChallenges.createdAt))
          .get();
        if (row === undefined) return undefined;
        const taken = tx
          .update(webAuthnChallenges)
          .set({ usedAt: now })
          .where(and(eq(webAuthnChallenges.id, row.id), isNull(webAuthnChallenges.usedAt)))
          .run().changes;
        return taken === 1 ? row.challenge : undefined;
      });
    },
    deleteChallengesBefore(at) {
      return db
        .delete(webAuthnChallenges)
        .where(or(lte(webAuthnChallenges.expiresAt, at), and(isNotNull(webAuthnChallenges.usedAt), lte(webAuthnChallenges.usedAt, at))))
        .run().changes;
    },
  };
}
