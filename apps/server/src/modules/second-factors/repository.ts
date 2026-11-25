import { and, asc, count, eq, gt, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import {
  recoveryCodes,
  secondFactorFailures,
  totpCredentials,
  type RecoveryCodeRow,
  type SecondFactorFailureRow,
  type TotpCredentialRow,
} from "./schema.ts";

export interface SecondFactorsRepository {
  insertTotp(row: TotpCredentialRow): void;
  findTotp(userId: string, id: string): TotpCredentialRow | undefined;
  listConfirmedTotp(userId: string): TotpCredentialRow[];
  confirmTotp(id: string, step: number, at: string): void;
  /** Accepts `step` only if it is after the stored one, so two requests can't both use it; answers whether it did. */
  useTotpStep(id: string, step: number, at: string): boolean;
  deleteTotp(id: string): void;
  deleteAllTotp(userId: string): number;
  deleteUnconfirmedTotpCreatedBefore(at: string): number;
  /** Replaces the account's recovery codes with `rows`, in one transaction. */
  replaceRecoveryCodes(userId: string, rows: readonly RecoveryCodeRow[]): void;
  listUnusedRecoveryCodes(userId: string): RecoveryCodeRow[];
  /** The current batch: its creation time and how many codes are left; undefined without one. */
  recoveryCodeBatch(userId: string): { readonly createdAt: string; readonly remaining: number } | undefined;
  /** Marks a code used unless it already is; answers whether this call did. */
  useRecoveryCode(id: string, at: string): boolean;
  deleteAllRecoveryCodes(userId: string): number;
  insertFailure(row: SecondFactorFailureRow): void;
  countFailuresSince(userId: string, since: string, sessionId?: string): number;
  deleteFailuresBefore(at: string): number;
  deleteAllFailures(userId: string): number;
}

export function createSecondFactorsRepository(db: Db): SecondFactorsRepository {
  return {
    insertTotp(row) {
      db.insert(totpCredentials).values(row).run();
    },
    findTotp(userId, id) {
      return db
        .select()
        .from(totpCredentials)
        .where(and(eq(totpCredentials.userId, userId), eq(totpCredentials.id, id)))
        .get();
    },
    listConfirmedTotp(userId) {
      return db
        .select()
        .from(totpCredentials)
        .where(and(eq(totpCredentials.userId, userId), isNotNull(totpCredentials.confirmedAt)))
        .orderBy(asc(totpCredentials.confirmedAt))
        .all();
    },
    confirmTotp(id, step, at) {
      db.update(totpCredentials).set({ confirmedAt: at, lastUsedStep: step, lastUsedAt: at }).where(eq(totpCredentials.id, id)).run();
    },
    useTotpStep(id, step, at) {
      return (
        db
          .update(totpCredentials)
          .set({ lastUsedStep: step, lastUsedAt: at })
          .where(
            and(
              eq(totpCredentials.id, id),
              isNotNull(totpCredentials.confirmedAt),
              or(isNull(totpCredentials.lastUsedStep), lt(totpCredentials.lastUsedStep, step)),
            ),
          )
          .run().changes === 1
      );
    },
    deleteTotp(id) {
      db.delete(totpCredentials).where(eq(totpCredentials.id, id)).run();
    },
    deleteAllTotp(userId) {
      return db.delete(totpCredentials).where(eq(totpCredentials.userId, userId)).run().changes;
    },
    deleteUnconfirmedTotpCreatedBefore(at) {
      return db
        .delete(totpCredentials)
        .where(and(isNull(totpCredentials.confirmedAt), lte(totpCredentials.createdAt, at)))
        .run().changes;
    },
    replaceRecoveryCodes(userId, rows) {
      db.transaction((tx) => {
        tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
        tx.insert(recoveryCodes)
          .values([...rows])
          .run();
      });
    },
    listUnusedRecoveryCodes(userId) {
      return db
        .select()
        .from(recoveryCodes)
        .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
        .all();
    },
    recoveryCodeBatch(userId) {
      const first = db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, userId)).limit(1).get();
      if (first === undefined) return undefined;
      const [row] = db
        .select({ remaining: count() })
        .from(recoveryCodes)
        .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
        .all();
      return { createdAt: first.createdAt, remaining: row?.remaining ?? 0 };
    },
    useRecoveryCode(id, at) {
      return (
        db
          .update(recoveryCodes)
          .set({ usedAt: at })
          .where(and(eq(recoveryCodes.id, id), isNull(recoveryCodes.usedAt)))
          .run().changes === 1
      );
    },
    deleteAllRecoveryCodes(userId) {
      return db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run().changes;
    },
    insertFailure(row) {
      db.insert(secondFactorFailures).values(row).run();
    },
    countFailuresSince(userId, since, sessionId) {
      const [row] = db
        .select({ failures: count() })
        .from(secondFactorFailures)
        .where(
          and(
            eq(secondFactorFailures.userId, userId),
            gt(secondFactorFailures.at, since),
            sessionId === undefined ? undefined : eq(secondFactorFailures.sessionId, sessionId),
          ),
        )
        .all();
      return row?.failures ?? 0;
    },
    deleteFailuresBefore(at) {
      return db.delete(secondFactorFailures).where(lte(secondFactorFailures.at, at)).run().changes;
    },
    deleteAllFailures(userId) {
      return db.delete(secondFactorFailures).where(eq(secondFactorFailures.userId, userId)).run().changes;
    },
  };
}
