import { ssoProviderKinds } from "@not-unreachable/contracts";
import { and, asc, count, eq, lte } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import {
  linkedSignIns,
  ssoFlows,
  ssoProviders,
  storedProviderKinds,
  type LinkedSignInRow,
  type SsoFlowRow,
  type SsoProviderRow,
} from "./schema.ts";

// The stored kinds are literals (schema.ts); fail at load if they ever drift from the contracts'.
if (storedProviderKinds.join() !== ssoProviderKinds.join())
  throw new Error("sso_providers.kind must list the contracts' SSO provider kinds");

export type ProviderChange = Partial<Pick<SsoProviderRow, "name" | "issuer" | "clientId" | "clientSecret" | "enabled" | "updatedAt">>;

export interface LinkWithProvider {
  readonly link: LinkedSignInRow;
  readonly provider: SsoProviderRow;
}

export interface SsoRepository {
  /** Oldest first. */
  listProviders(): SsoProviderRow[];
  findProvider(id: string): SsoProviderRow | undefined;
  findProviderByIssuer(issuer: string): SsoProviderRow | undefined;
  insertProvider(row: SsoProviderRow): void;
  updateProvider(id: string, change: ProviderChange): void;
  deleteProvider(id: string): void;
  /** How many linked sign-ins each provider has; a provider with none is left out. */
  linkCounts(): Map<string, number>;
  insertFlow(row: SsoFlowRow): void;
  /** The flow bound to this cookie hash, deleted in the same transaction: a flow is used at most once. */
  takeFlow(bindingHash: string): SsoFlowRow | undefined;
  deleteFlowsExpiredBy(at: string): number;
  findLinkByIdentity(issuer: string, subject: string): LinkedSignInRow | undefined;
  findLink(userId: string, id: string): LinkedSignInRow | undefined;
  /** The account's links with their providers, oldest first. */
  listLinks(userId: string): LinkWithProvider[];
  insertLink(row: LinkedSignInRow): void;
  deleteLink(id: string): void;
  touchLink(id: string, at: string): void;
}

export function createSsoRepository(db: Db): SsoRepository {
  return {
    listProviders() {
      return db.select().from(ssoProviders).orderBy(asc(ssoProviders.createdAt), asc(ssoProviders.id)).all();
    },
    findProvider(id) {
      return db.select().from(ssoProviders).where(eq(ssoProviders.id, id)).get();
    },
    findProviderByIssuer(issuer) {
      return db.select().from(ssoProviders).where(eq(ssoProviders.issuer, issuer)).get();
    },
    insertProvider(row) {
      db.insert(ssoProviders).values(row).run();
    },
    updateProvider(id, change) {
      db.update(ssoProviders).set(change).where(eq(ssoProviders.id, id)).run();
    },
    deleteProvider(id) {
      db.transaction((tx) => {
        tx.delete(ssoFlows).where(eq(ssoFlows.providerId, id)).run();
        tx.delete(ssoProviders).where(eq(ssoProviders.id, id)).run();
      });
    },
    linkCounts() {
      const rows = db
        .select({ providerId: linkedSignIns.providerId, links: count() })
        .from(linkedSignIns)
        .groupBy(linkedSignIns.providerId)
        .all();
      return new Map(rows.map((row) => [row.providerId, row.links]));
    },
    insertFlow(row) {
      db.insert(ssoFlows).values(row).run();
    },
    takeFlow(bindingHash) {
      return db.transaction((tx) => {
        const row = tx.select().from(ssoFlows).where(eq(ssoFlows.bindingHash, bindingHash)).get();
        if (row !== undefined) tx.delete(ssoFlows).where(eq(ssoFlows.id, row.id)).run();
        return row;
      });
    },
    deleteFlowsExpiredBy(at) {
      return db.delete(ssoFlows).where(lte(ssoFlows.expiresAt, at)).run().changes;
    },
    findLinkByIdentity(issuer, subject) {
      return db
        .select()
        .from(linkedSignIns)
        .where(and(eq(linkedSignIns.issuer, issuer), eq(linkedSignIns.subject, subject)))
        .get();
    },
    findLink(userId, id) {
      return db
        .select()
        .from(linkedSignIns)
        .where(and(eq(linkedSignIns.userId, userId), eq(linkedSignIns.id, id)))
        .get();
    },
    listLinks(userId) {
      return db
        .select({ link: linkedSignIns, provider: ssoProviders })
        .from(linkedSignIns)
        .innerJoin(ssoProviders, eq(linkedSignIns.providerId, ssoProviders.id))
        .where(eq(linkedSignIns.userId, userId))
        .orderBy(asc(linkedSignIns.createdAt), asc(linkedSignIns.id))
        .all();
    },
    insertLink(row) {
      db.insert(linkedSignIns).values(row).run();
    },
    deleteLink(id) {
      db.delete(linkedSignIns).where(eq(linkedSignIns.id, id)).run();
    },
    touchLink(id, at) {
      db.update(linkedSignIns).set({ lastUsedAt: at }).where(eq(linkedSignIns.id, id)).run();
    },
  };
}
