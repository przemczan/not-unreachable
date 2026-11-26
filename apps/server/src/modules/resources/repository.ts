import { resourceKinds, resourceStates, smbProtocols, unavailableReasons } from "@not-unreachable/contracts";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import {
  homes,
  resources,
  storedKinds,
  storedReasons,
  storedSmbProtocols,
  storedStates,
  type HomeRow,
  type NewResourceRow,
  type ResourceRow,
} from "./schema.ts";

/** The schema's literals must be the contracts' exactly (both ways), or this file doesn't compile. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameLists: [
  Same<(typeof storedKinds)[number], (typeof resourceKinds)[number]>,
  Same<(typeof storedStates)[number], (typeof resourceStates)[number]>,
  Same<(typeof storedReasons)[number], (typeof unavailableReasons)[number]>,
  Same<(typeof storedSmbProtocols)[number], (typeof smbProtocols)[number]>,
] = [true, true, true, true];
void sameLists;

export type ResourceRowChange = Partial<Omit<ResourceRow, "id" | "kind" | "createdAt">>;

export interface ResourcesRepository {
  /** Runs `work` in one SQLite transaction; it must not await. */
  transaction<T>(work: () => T): T;

  listResources(): ResourceRow[];
  /** The resources by their stored state, in one aggregate query. */
  countByState(): { readonly available: number; readonly unavailable: number };
  findResource(id: string): ResourceRow | undefined;
  findResourceByName(name: string): ResourceRow | undefined;
  findHomeRoot(): ResourceRow | undefined;
  insertResource(row: NewResourceRow): void;
  updateResource(id: string, change: ResourceRowChange): void;
  deleteResource(id: string): void;

  findHome(username: string): HomeRow | undefined;
  /** Answers whether any home lives in the resource. */
  holdsHomes(resourceId: string): boolean;
  /** Inserts the home unless one is already recorded for the user. */
  insertHome(row: HomeRow): void;
  deleteHome(username: string): void;
}

export function createResourcesRepository(db: Db): ResourcesRepository {
  return {
    transaction: (work) => db.transaction(() => work()),

    listResources: () => db.select().from(resources).orderBy(asc(resources.name), asc(resources.id)).all(),
    countByState() {
      const counts = db
        .select({
          available: sql<number>`count(*) filter (where ${eq(resources.state, "available")})`.mapWith(Number),
          unavailable: sql<number>`count(*) filter (where ${eq(resources.state, "unavailable")})`.mapWith(Number),
        })
        .from(resources)
        .get();
      return { available: counts?.available ?? 0, unavailable: counts?.unavailable ?? 0 };
    },
    findResource: (id) => db.select().from(resources).where(eq(resources.id, id)).get(),
    findResourceByName: (name) => db.select().from(resources).where(eq(resources.name, name)).get(),
    findHomeRoot: () => db.select().from(resources).where(eq(resources.isHomeRoot, true)).get(),
    insertResource(row) {
      db.insert(resources).values(row).run();
    },
    updateResource(id, change) {
      db.update(resources).set(change).where(eq(resources.id, id)).run();
    },
    deleteResource(id) {
      db.delete(resources).where(eq(resources.id, id)).run();
    },

    findHome: (username) => db.select().from(homes).where(eq(homes.username, username)).get(),
    holdsHomes: (resourceId) =>
      db.select({ username: homes.username }).from(homes).where(eq(homes.resourceId, resourceId)).limit(1).get() !== undefined,
    insertHome(row) {
      db.insert(homes).values(row).onConflictDoNothing({ target: homes.username }).run();
    },
    deleteHome(username) {
      db.delete(homes).where(eq(homes.username, username)).run();
    },
  };
}
