import {
  isShareFailure,
  type HomeRoot,
  type NewResource,
  type Resource,
  type ResourceChange,
  type ResourceCheck,
  type ResourceCheckRequest,
  type ResourceList,
} from "@not-unreachable/contracts";
import type { AuditActor, AuditOrigin, AuditService } from "../audit/index.ts";
import { newId, type Clock, type Logger } from "../platform/index.ts";
import {
  checkName,
  list,
  makeFolder,
  NameRefusedError,
  PathRefusedError,
  remove,
  resolveInResource,
  stat,
  type ContainedPath,
  type RealPath,
} from "../storage/index.ts";
import {
  FolderRefusedError,
  HomeNotFoundError,
  HomeRootNotSetError,
  ResourceInUseError,
  ResourceKindMismatchError,
  ResourceNameTakenError,
  ResourceNotFoundError,
  ResourceUnavailableError,
  ShareRefusedError,
} from "./errors.ts";
import { definitionOf, type KindRefusal, type ResourceChangedField, type ResourceKindRegistry } from "./kinds.ts";
import type { ResourceRowChange, ResourcesRepository } from "./repository.ts";
import type { HomeRow, NewResourceRow, ResourceRow } from "./schema.ts";

const placeOf = (home: HomeRow): HomePlace => ({ resourceId: home.resourceId, path: home.path });

export interface HomeRootChange {
  readonly resourceId: string;
  /** "" for the resource's top folder, else a relative path; missing folders are made. */
  readonly subpath: string;
}

/** Where a user's home is recorded: its resource, and its folder relative to that resource's root. */
export interface HomePlace {
  readonly resourceId: string;
  readonly path: string;
}

/** How many resources are available and unavailable. */
export interface ResourceCounts {
  readonly available: number;
  readonly unavailable: number;
}

export interface ResourcesService {
  list(): ResourceList;
  /**
   * The resources by the state the list shows: the one stored on each row, which startup, Retry and
   * the automatic retries keep up to date. One aggregate query; it checks no folder or share.
   */
  countByState(): ResourceCounts;
  /** Throws {@link ResourceNotFoundError}. */
  get(id: string): Resource;
  /** Throws {@link FolderRefusedError}, {@link ShareRefusedError}, {@link ResourceNameTakenError}; records `resource.added`. */
  add(input: NewResource, actor: AuditActor, origin?: AuditOrigin): Promise<Resource>;
  /**
   * Changes the name and the kind's fields; new kind settings are checked and the root fixed again
   * (an SMB share is mounted again), which makes the resource available. Records `resource.changed` only when something changed.
   * Throws {@link ResourceNotFoundError}, {@link ResourceKindMismatchError}, {@link FolderRefusedError},
   * {@link ShareRefusedError}, {@link ResourceNameTakenError}, and the smb kind's `SharePasswordRequiredError`.
   */
  change(id: string, change: ResourceChange, actor: AuditActor, origin?: AuditOrigin): Promise<Resource>;
  /**
   * Forgets the resource (its kind deactivates it: an SMB share is unmounted); nothing on disk is
   * deleted. Throws {@link ResourceInUseError}; records `resource.removed`.
   */
  remove(id: string, actor: AuditActor, origin?: AuditOrigin): Promise<void>;
  /** Checks the resource again, as startup does, and stores what it found. */
  retry(id: string): Promise<Resource>;
  /** Retries every unavailable resource whose kind says its automatic retry is due (an SMB share's backoff). */
  retryDue(): Promise<void>;
  /** What adding these settings would answer; changes nothing. */
  check(request: ResourceCheckRequest): Promise<ResourceCheck>;
  /**
   * Moves the home root; existing homes stay where they are. Throws {@link ResourceNotFoundError},
   * {@link ResourceUnavailableError}, `PathRefusedError`, `NameRefusedError`; records `home-root.changed`.
   */
  setHomeRoot(change: HomeRootChange, actor: AuditActor, origin?: AuditOrigin): Promise<HomeRoot>;
  isHomeRootSet(): boolean;
  /**
   * The user's recorded home, which must still be a folder: a user's root (threat model, T5 step 8).
   * Throws {@link HomeNotFoundError}, {@link ResourceUnavailableError}, `PathRefusedError`.
   */
  homeFor(username: string): Promise<RealPath>;
  /**
   * Makes and records the user's home in the home root, or answers the one already recorded.
   * Throws {@link HomeRootNotSetError}, {@link ResourceUnavailableError}, `NameRefusedError`,
   * `NameTakenError` when a folder of that name is already there, and `PathRefusedError`
   * (`symlink`, `not-a-folder`) when something else holds the name.
   */
  createHome(username: string): Promise<RealPath>;
  /** Where the user's home is recorded, without checking the folder; undefined when none is. */
  homePlace(username: string): HomePlace | undefined;
  /** Every recorded home's place by username, in one query. */
  homePlaces(): ReadonlyMap<string, HomePlace>;
  /** Whether the user has a recorded home that is still a folder; false when its resource is unavailable too. */
  homeExists(username: string): Promise<boolean>;
  /**
   * Deletes the user's recorded home with everything in it (through `storage.remove`, which never
   * follows a symlink), then forgets it; nothing when none is recorded. With `onlyIfEmpty`, a home
   * that holds anything is only forgotten, never deleted: for undoing a home made a moment ago.
   * Throws {@link ResourceUnavailableError}, `PathRefusedError`.
   */
  removeHome(username: string, options?: { readonly onlyIfEmpty?: boolean }): Promise<void>;
  /** Forgets the user's recorded home; the folder, if any, stays. */
  forgetHome(username: string): void;
  /** A resource's root, for Files and Share links. Throws {@link ResourceNotFoundError}, {@link ResourceUnavailableError}. */
  rootFor(resourceId: string): RealPath;
  /** Checks every resource's root, marking each available or unavailable with the reason. */
  checkAtStartup(): Promise<void>;
}

export interface ResourcesServiceDependencies {
  readonly repository: ResourcesRepository;
  readonly kinds: ResourceKindRegistry;
  readonly audit: AuditService;
  readonly clock: Clock;
  readonly logger: Logger;
}

function asRealPath(path: string): RealPath {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored from `fixRoot`'s real path, re-checked by resolveInResource.
  return path as RealPath;
}

/** An available resource's root; throws {@link ResourceUnavailableError}. */
function rootOf(row: ResourceRow): RealPath {
  if (row.state !== "available") throw new ResourceUnavailableError();
  return asRealPath(row.rootRealpath);
}

function refused(refusal: KindRefusal): FolderRefusedError | ShareRefusedError {
  return isShareFailure(refusal.reason)
    ? new ShareRefusedError(refusal.reason)
    : new FolderRefusedError(refusal.reason, refusal.command, refusal.allowFromUi);
}

/** Runs work for one resource at a time, in the order it was asked for. */
type ResourceLock = <T>(id: string, work: () => Promise<T>) => Promise<T>;

/**
 * Change, Remove, Retry and the automatic retries of one resource never overlap: for an SMB share
 * each stops and starts the same unit, and the helper mounts whichever request file it finds.
 */
function createResourceLock(): ResourceLock {
  const queues = new Map<string, Promise<unknown>>();
  return async (id, work) => {
    const run = (queues.get(id) ?? Promise.resolve()).then(work);
    const queue = run.catch(() => undefined);
    queues.set(id, queue);
    try {
      return await run;
    } finally {
      if (queues.get(id) === queue) queues.delete(id);
    }
  };
}

/** The folder at `subpath` in the root, made segment by segment where missing. */
async function ensureFolder(root: RealPath, subpath: string): Promise<ContainedPath> {
  try {
    const found = await resolveInResource(root, subpath);
    // The last segment may not exist yet; makeFolder below makes it (or refuses a file there).
    if (found.relative === "") return found;
  } catch (error) {
    // A missing parent is made below; every other refusal stands.
    if (!(error instanceof PathRefusedError && error.reason === "not-found")) throw error;
  }
  let folder = await resolveInResource(root, "");
  for (const segment of subpath.normalize("NFC").split("/")) {
    if (segment !== "") folder = await makeFolder(folder, segment);
  }
  return folder;
}

export function createResourcesServiceWith({ repository, kinds, audit, clock, logger }: ResourcesServiceDependencies): ResourcesService {
  const now = (): string => clock.now().toISOString();
  const exclusive = createResourceLock();

  const find = (id: string): ResourceRow => {
    const row = repository.findResource(id);
    if (row === undefined) throw new ResourceNotFoundError();
    return row;
  };

  const toResource = (row: ResourceRow): Resource => ({
    id: row.id,
    name: row.name,
    state: row.state,
    unavailableReason: row.state === "available" ? null : row.unavailableReason,
    isHomeRoot: row.isHomeRoot,
    createdAt: row.createdAt,
    ...definitionOf(kinds, row.kind).present(row),
  });

  const assertNameFree = (name: string, exceptId?: string): void => {
    const holder = repository.findResourceByName(name);
    if (holder !== undefined && holder.id !== exceptId) throw new ResourceNameTakenError();
  };

  const assertRemovable = (row: ResourceRow): void => {
    if (row.isHomeRoot) throw new ResourceInUseError("home-root");
    if (repository.holdsHomes(row.id)) throw new ResourceInUseError("holds-homes");
  };

  /** Runs the kind's activation and stores what it found. */
  const activate = async (row: ResourceRow): Promise<ResourceRow> => {
    const activation = await definitionOf(kinds, row.kind).activate(row);
    const change: ResourceRowChange = activation.ok
      ? { state: "available", unavailableReason: null }
      : { state: "unavailable", unavailableReason: activation.reason };
    repository.updateResource(row.id, change);
    return { ...row, ...change };
  };

  const logActivation = (row: ResourceRow): void => {
    const fields = { resourceId: row.id, resourceName: row.name, state: row.state, reason: row.unavailableReason };
    if (row.state === "available") logger.info(fields, "Resource is available");
    else logger.warn(fields, `Resource "${row.name}" is unavailable (${String(row.unavailableReason)})`);
  };

  /** The user's recorded home as a contained path, checked to be a folder. */
  const containedHome = async (username: string): Promise<ContainedPath> => {
    const home = repository.findHome(username);
    if (home === undefined) throw new HomeNotFoundError();
    const path = await resolveInResource(rootOf(find(home.resourceId)), home.path);
    if ((await stat(path)).kind !== "folder") throw new PathRefusedError("not-a-folder");
    return path;
  };

  const homeFor = async (username: string): Promise<RealPath> => (await containedHome(username)).absolute;

  return {
    countByState: () => repository.countByState(),

    list() {
      const homeRoot = repository.findHomeRoot();
      return {
        resources: repository.listResources().map(toResource),
        homeRoot: homeRoot === undefined ? null : { resourceId: homeRoot.id, subpath: homeRoot.homeRootSubpath ?? "" },
      };
    },

    get: (id) => toResource(find(id)),

    async add(input, actor, origin) {
      assertNameFree(input.name);
      const definition = definitionOf(kinds, input.kind);
      const id = newId(clock);
      const prepared = await definition.prepare(input, id);
      if (!prepared.ok) throw refused(prepared);
      const row: NewResourceRow = {
        ...prepared.columns,
        id,
        name: input.name,
        kind: input.kind,
        rootRealpath: prepared.realPath,
        isHomeRoot: false,
        homeRootSubpath: null,
        state: "available",
        unavailableReason: null,
        createdAt: now(),
      };
      try {
        repository.transaction(() => {
          // Checked again: another request may have taken the name while the settings were checked.
          assertNameFree(input.name);
          repository.insertResource(row);
          audit.record({
            action: "resource.added",
            actor,
            outcome: "succeeded",
            target: { kind: "resource", id },
            ...(origin === undefined ? {} : { origin }),
            details: { kind: row.kind, name: row.name },
          });
        });
      } catch (error) {
        // Not saved, so nothing may stay active for it (an SMB share stays mounted otherwise).
        await definition.deactivate(id);
        throw error;
      }
      return toResource(find(id));
    },

    change: async (id, change, actor, origin) =>
      exclusive(id, async () => {
        const row = find(id);
        if (change.kind !== row.kind) throw new ResourceKindMismatchError();
        // Before the kind's checks, which may remount a share for a name that's taken anyway.
        if (change.name !== undefined && change.name !== row.name) assertNameFree(change.name, id);
        const prepared = await definitionOf(kinds, row.kind).prepareChange(row, change);
        if (!prepared.ok) throw refused(prepared);
        const name = change.name !== undefined && change.name !== row.name ? change.name : undefined;
        const fields: ResourceChangedField[] = [...(name === undefined ? [] : ["name" as const]), ...prepared.fields];
        if (fields.length === 0) return toResource(find(id));
        const rowChange: ResourceRowChange = {
          ...(name === undefined ? {} : { name }),
          ...("realPath" in prepared
            ? { ...prepared.columns, rootRealpath: prepared.realPath, state: "available", unavailableReason: null }
            : {}),
        };
        repository.transaction(() => {
          find(id);
          if (name !== undefined) assertNameFree(name, id);
          repository.updateResource(id, rowChange);
          audit.record({
            action: "resource.changed",
            actor,
            outcome: "succeeded",
            target: { kind: "resource", id },
            ...(origin === undefined ? {} : { origin }),
            details: { fields },
          });
        });
        return toResource(find(id));
      }),

    remove: async (id, actor, origin) =>
      exclusive(id, async () => {
        const row = find(id);
        assertRemovable(row);
        await definitionOf(kinds, row.kind).deactivate(row.id);
        repository.transaction(() => {
          assertRemovable(find(id));
          repository.deleteResource(id);
          audit.record({
            action: "resource.removed",
            actor,
            outcome: "succeeded",
            target: { kind: "resource", id },
            ...(origin === undefined ? {} : { origin }),
            details: { kind: row.kind, name: row.name },
          });
        });
      }),

    retry: async (id) =>
      exclusive(id, async () => {
        const row = await activate(find(id));
        logActivation(row);
        return toResource(row);
      }),

    async retryDue() {
      for (const definition of Object.values(kinds)) {
        for (const id of definition.dueForRetry()) {
          await exclusive(id, async () => {
            // Read under the lock: a change or a removal may have run while this one waited.
            const row = repository.findResource(id);
            if (row?.state !== "unavailable") return;
            try {
              logActivation(await activate(row));
            } catch (error) {
              logger.error({ err: error, resourceId: row.id, resourceName: row.name }, "Resource retry failed");
            }
          });
        }
      }
    },

    check: async (request) => definitionOf(kinds, request.kind).test(request),

    async setHomeRoot({ resourceId, subpath }, actor, origin) {
      const row = find(resourceId);
      const folder = await ensureFolder(rootOf(row), subpath);
      const homeRoot: HomeRoot = { resourceId, subpath: folder.relative };
      const current = repository.findHomeRoot();
      if (current?.id === resourceId && current.homeRootSubpath === folder.relative) return homeRoot;
      repository.transaction(() => {
        rootOf(find(resourceId));
        // Read again: another request may have moved the home root while the folder was made.
        const previous = repository.findHomeRoot();
        if (previous !== undefined) repository.updateResource(previous.id, { isHomeRoot: false, homeRootSubpath: null });
        repository.updateResource(resourceId, { isHomeRoot: true, homeRootSubpath: folder.relative });
        audit.record({
          action: "home-root.changed",
          actor,
          outcome: "succeeded",
          target: { kind: "resource", id: resourceId },
          ...(origin === undefined ? {} : { origin }),
          details: {
            previousResourceId: previous?.id ?? null,
            previousSubpath: previous === undefined ? null : (previous.homeRootSubpath ?? ""),
            subpath: folder.relative,
          },
        });
      });
      return homeRoot;
    },

    isHomeRootSet: () => repository.findHomeRoot() !== undefined,

    homeFor,

    async createHome(username) {
      if (repository.findHome(username) !== undefined) return homeFor(username);
      const homeRoot = repository.findHomeRoot();
      if (homeRoot === undefined) throw new HomeRootNotSetError();
      const name = checkName(username);
      if (!name.ok) throw new NameRefusedError(name.reason);
      const parent = await ensureFolder(rootOf(homeRoot), homeRoot.homeRootSubpath ?? "");
      // A folder already there is someone's (an older home root, the admin's files): never handed over.
      const home = await makeFolder(parent, name.name, { mustBeNew: true });
      // Kept if another call recorded the user's home first under another home root; both then
      // answer that one. A call racing for this same folder got NameTakenError above.
      repository.insertHome({ username, resourceId: homeRoot.id, path: home.relative, createdAt: now() });
      return homeFor(username);
    },

    homePlace(username) {
      const home = repository.findHome(username);
      return home === undefined ? undefined : placeOf(home);
    },

    homePlaces: () => new Map(repository.listHomes().map((home) => [home.username, placeOf(home)])),

    async homeExists(username) {
      try {
        await containedHome(username);
        return true;
      } catch (error) {
        if (error instanceof HomeNotFoundError || error instanceof ResourceUnavailableError || error instanceof PathRefusedError)
          return false;
        throw error;
      }
    },

    async removeHome(username, options = {}) {
      const home = repository.findHome(username);
      if (home === undefined) return;
      const path = await resolveInResource(rootOf(find(home.resourceId)), home.path).catch((error: unknown) => {
        // Gone already: only the record is left to drop.
        if (error instanceof PathRefusedError && error.reason === "not-found") return undefined;
        throw error;
      });
      if (path !== undefined && path.relative !== "") {
        const empty = (await stat(path)).kind === "folder" && (await list(path)).length === 0;
        if (options.onlyIfEmpty !== true || empty) await remove(path);
      }
      repository.deleteHome(username);
    },

    forgetHome(username) {
      repository.deleteHome(username);
    },

    rootFor: (resourceId) => rootOf(find(resourceId)),

    async checkAtStartup() {
      const rows = repository.listResources();
      for (const row of rows) {
        try {
          logActivation(await activate(row));
        } catch (error) {
          logger.error({ err: error, resourceId: row.id, resourceName: row.name }, "Resource check failed");
        }
      }
      for (const definition of Object.values(kinds)) {
        await definition.onStartup(rows.filter((row) => row.kind === definition.kind));
      }
    },
  };
}
