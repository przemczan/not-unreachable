import { isDeepStrictEqual } from "node:util";
import {
  homeUploadMetadataSchema,
  resourceUploadMetadataSchema,
  type EntriesPage,
  type Entry,
  type Quota,
  type Role,
  type UploadConflictChoice,
  type UploadLimits,
} from "@not-unreachable/contracts";
import { z } from "zod";
import type { AccountsService } from "../accounts/index.ts";
import type { AuditActor, AuditOrigin, AuditService } from "../audit/index.ts";
import type { Clock, Logger } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import type { SettingsService } from "../settings/index.ts";
import {
  checkName,
  freeSpace as storageFreeSpace,
  list,
  makeFolder,
  moveIntoPlace,
  NameRefusedError,
  NameTakenError,
  PathRefusedError,
  remove,
  resolveInResource,
  stat,
  usedBytes,
  type ContainedPath,
  type FreeSpace,
  type NameConflict,
  type RealPath,
} from "../storage/index.ts";
import {
  FileTooLargeError,
  FolderNotEmptyError,
  InsufficientStorageError,
  InvalidEntriesCursorError,
  QuotaExceededError,
  TooManyUploadsError,
  UploadMetadataError,
  UploadNotFoundError,
} from "./errors.ts";
import { refusalProblem } from "./problems.ts";
import type { UploadsRepository } from "./repository.ts";
import type { UploadRow } from "./schema.ts";
import type { StagingArea } from "./staging.ts";

const HOUR_MS = 60 * 60 * 1000;
/** An unfinished upload expires this long after its last chunk (threat model, T7). */
export const UPLOAD_EXPIRY_MS = 24 * HOUR_MS;
/** A `.nu-upload-*` temporary file older than this is left over from an interrupted move. */
export const TEMP_FILE_MAX_AGE_MS = HOUR_MS;
const TEMP_PREFIX = ".nu-upload-";

/** Where a request's files are: a resource, for the admin, or the caller's own home (T5 step 8). */
export type FilesPlace = { readonly kind: "resource"; readonly resourceId: string } | { readonly kind: "home"; readonly username: string };

/** The account behind an upload request. */
export interface UploadCaller {
  readonly accountId: string;
  readonly username: string;
  readonly role: Role;
}

export interface EntriesRequest {
  readonly path: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface DeleteRequest {
  readonly path: string;
  readonly recursive: boolean;
}

/** Free space, injected so tests can fake `statfs`. */
export interface FreeSpaceProbes {
  /** The staging disk. */
  readonly staging: () => Promise<FreeSpace>;
  /** The disk of a target folder. */
  readonly target: (folder: ContainedPath) => Promise<FreeSpace>;
}

export interface CleanupResult {
  readonly expired: number;
  readonly tempFiles: number;
  readonly orphans: number;
}

export interface FilesService {
  /** Folders first, then the rest, each by name; at most `limit`, then a cursor. */
  list(place: FilesPlace, request: EntriesRequest): Promise<EntriesPage>;
  /** Throws `NameTakenError` when anything holds the name. */
  createFolder(place: FilesPlace, parent: string, name: string): Promise<Entry>;
  /** The file to download, checked (T5); `sendContained` opens and streams it. */
  resolve(place: FilesPlace, path: string): Promise<ContainedPath>;
  /** Never the top folder; a folder that holds anything needs `recursive`. Records `file.deleted`. */
  delete(place: FilesPlace, request: DeleteRequest, actor: AuditActor, origin: AuditOrigin): Promise<void>;
  /** A user's quota: the home's bytes plus their unfinished uploads, and their limit. */
  quota(accountId: string, username: string): Promise<Quota>;

  limits(): UploadLimits;
  /** Records `settings.changed` when the values changed. */
  updateLimits(values: UploadLimits, actor: Extract<AuditActor, { kind: "account" }>, origin: AuditOrigin): UploadLimits;

  /** Throws {@link UploadNotFoundError} unless the upload is the account's and hasn't expired. */
  assertOwnUpload(accountId: string, uploadId: string): void;
  /**
   * Every check at tus creation (threat model, T5 and T7), before any byte is stored: target,
   * folder, name, conflict, size limit, the limits on uploads, quota and disk reserve. Then records
   * the upload.
   */
  createUpload(caller: UploadCaller, uploadId: string, metadata: Record<string, string | null> | undefined, size: number): Promise<void>;
  /** After a chunk: the new offset, and the expiry moved to 24 hours from now. */
  recordChunk(uploadId: string, offset: number): void;
  /**
   * The last chunk is in: checks the quota and the conflict again, moves the file into place and
   * forgets the upload; records `file.uploaded`. A refusal drops the upload with its staged bytes.
   */
  finishUpload(caller: UploadCaller, uploadId: string, origin: AuditOrigin): Promise<void>;
  /**
   * The hourly cleanup: drops uploads 24 hours after their last chunk, `.nu-upload-*` files left
   * in a target over an hour, and staged files that have no upload.
   */
  cleanup(): Promise<CleanupResult>;
}

export interface FilesServiceDependencies {
  readonly repository: UploadsRepository;
  readonly staging: StagingArea;
  readonly resources: Pick<ResourcesService, "rootFor" | "homeFor">;
  readonly accounts: Pick<AccountsService, "findById">;
  readonly settings: SettingsService;
  readonly audit: AuditService;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly freeSpace?: Partial<FreeSpaceProbes>;
}

const cursorSchema = z.tuple([z.union([z.literal(0), z.literal(1)]), z.string()]);

function rankOf(entry: Entry): 0 | 1 {
  return entry.kind === "folder" ? 0 : 1;
}

function compareEntries(a: readonly [number, string], b: readonly [number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

function encodeCursor(entry: Entry): string {
  return Buffer.from(JSON.stringify([rankOf(entry), entry.name])).toString("base64url");
}

function decodeCursor(cursor: string): readonly [number, string] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidEntriesCursorError();
  }
  const result = cursorSchema.safeParse(decoded);
  if (!result.success) throw new InvalidEntriesCursorError();
  return result.data;
}

function childPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

const conflictRule: Record<UploadConflictChoice, NameConflict> = { fail: "refuse", replace: "replace", "keep-both": "keep-both" };

/** Whether `bytes` more leave at least the reserve free: `percent` of the disk and `bytes`. */
function leavesReserve(space: FreeSpace, bytes: number, reserve: UploadLimits["diskReserve"]): boolean {
  const left = space.availableBytes - bytes;
  return left >= reserve.bytes && left >= (space.totalBytes * reserve.percent) / 100;
}

function toEntry(entry: Entry): Entry {
  return { name: entry.name, kind: entry.kind, size: entry.size, modifiedAt: entry.modifiedAt };
}

/**
 * One page of a folder: folders first, then the rest, each by name; at most `limit`, then a cursor.
 * Share links list inside a shared folder with it too. Throws `InvalidEntriesCursorError`.
 */
export async function listEntries(folder: ContainedPath, { cursor, limit }: Omit<EntriesRequest, "path">): Promise<EntriesPage> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  const sorted = (await list(folder))
    .map(toEntry)
    .toSorted((a, b) => compareEntries([rankOf(a), a.name], [rankOf(b), b.name]))
    .filter((entry) => after === undefined || compareEntries([rankOf(entry), entry.name], after) > 0);
  const entries = sorted.slice(0, limit);
  const last = entries.at(-1);
  return { path: folder.relative, entries, nextCursor: sorted.length > limit && last !== undefined ? encodeCursor(last) : null };
}

/** The tus metadata of an upload, as the client sent it (names as checked). */
export function uploadMetadataOf(row: UploadRow): Record<string, string> {
  return {
    folder: row.targetPath,
    name: row.fileName,
    onConflict: row.onConflict,
    ...(row.targetResourceId === null ? {} : { resourceId: row.targetResourceId }),
  };
}

/** What a creation's metadata asks for, before it is checked. */
interface WantedUpload {
  readonly place: FilesPlace;
  readonly folder: string;
  readonly name: string;
  readonly onConflict: UploadConflictChoice;
}

/** The checked target of an upload. */
interface UploadTarget {
  readonly place: FilesPlace;
  readonly folder: ContainedPath;
  readonly name: string;
}

function acceptName(name: string): string {
  const checked = checkName(name);
  if (!checked.ok) throw new NameRefusedError(checked.reason);
  return checked.name;
}

/** Throws `NameTakenError` when the choice can't take the name as it stands. */
async function assertNoConflict(target: UploadTarget, choice: UploadConflictChoice): Promise<void> {
  if (choice === "keep-both") return;
  let existing: Entry;
  try {
    existing = await stat(await resolveInResource(target.folder.root, childPath(target.folder.relative, target.name)));
  } catch (error) {
    if (error instanceof PathRefusedError && error.reason === "not-found") return;
    // A symlink or a special file holds the name: neither is ever replaced.
    if (error instanceof PathRefusedError && (error.reason === "symlink" || error.reason === "special-file")) throw new NameTakenError();
    throw error;
  }
  if (choice === "fail" || existing.kind !== "file") throw new NameTakenError();
}

function metadataError(error: z.ZodError): UploadMetadataError {
  return new UploadMetadataError(
    error.issues
      .slice(0, 10)
      .map((issue) => `metadata${issue.path.length === 0 ? "" : `.${issue.path.join(".")}`}: ${issue.message}`)
      .join("; "),
  );
}

/** The creation's metadata by the caller's schema: a user's names no resource, the admin's must. */
function parseMetadata(caller: UploadCaller, metadata: Record<string, string | null> | undefined): WantedUpload {
  // tus-js-client sends an empty value as a key alone, which tus parses as null.
  const values = Object.fromEntries(Object.entries(metadata ?? {}).map(([key, value]) => [key, value ?? ""]));
  if (caller.role === "admin") {
    const result = resourceUploadMetadataSchema.safeParse(values);
    if (!result.success) throw metadataError(result.error);
    const { resourceId, ...wanted } = result.data;
    return { place: { kind: "resource", resourceId }, ...wanted };
  }
  const result = homeUploadMetadataSchema.safeParse(values);
  if (!result.success) throw metadataError(result.error);
  return { place: { kind: "home", username: caller.username }, ...result.data };
}

export function createFilesServiceWith({
  repository,
  staging,
  resources,
  accounts,
  settings,
  audit,
  clock,
  logger,
  freeSpace = {},
}: FilesServiceDependencies): FilesService {
  const probes: FreeSpaceProbes = {
    staging: freeSpace.staging ?? (() => staging.freeSpace()),
    target: freeSpace.target ?? storageFreeSpace,
  };
  const now = (): string => clock.now().toISOString();
  /** Each account's tus creations in the last hour: a sliding window on the clock. */
  const creations = new Map<string, number[]>();

  const rootOf = async (place: FilesPlace): Promise<RealPath> =>
    place.kind === "resource" ? resources.rootFor(place.resourceId) : resources.homeFor(place.username);

  const resolveIn = async (place: FilesPlace, path: string): Promise<ContainedPath> => resolveInResource(await rootOf(place), path);

  /** A folder that must exist. */
  const folderAt = async (place: FilesPlace, path: string): Promise<ContainedPath> => {
    const folder = await resolveIn(place, path);
    if ((await stat(folder)).kind !== "folder") throw new PathRefusedError("not-a-folder");
    return folder;
  };

  const quotaLimit = (accountId: string): number => {
    const account = accounts.findById(accountId);
    if (account === undefined) throw new UploadNotFoundError();
    return account.quotaBytes ?? settings.get("defaultQuotaBytes");
  };

  /** The bytes in the caller's home; 0 for the admin, who has no quota. */
  const homeBytesOf = async (caller: UploadCaller): Promise<number> =>
    caller.role === "admin" ? 0 : usedBytes(await resolveIn({ kind: "home", username: caller.username }, ""));

  /** With no await, so the unfinished uploads it counts are those recorded right now. */
  const assertQuota = (caller: UploadCaller, homeBytes: number, size: number, exceptId?: string): void => {
    if (caller.role === "admin") return;
    const used = homeBytes + repository.liveBytes(caller.accountId, now(), exceptId);
    if (used + size > quotaLimit(caller.accountId)) throw new QuotaExceededError();
  };

  const assertTargetReserve = async (folder: ContainedPath, size: number, limits: UploadLimits): Promise<void> => {
    if (!leavesReserve(await probes.target(folder), size, limits.diskReserve)) throw new InsufficientStorageError();
  };

  const recentCreations = (accountId: string, at: number): number[] => {
    const recent = (creations.get(accountId) ?? []).filter((time) => time > at - HOUR_MS);
    if (recent.length === 0) creations.delete(accountId);
    else creations.set(accountId, recent);
    return recent;
  };

  /** The three limits, checked with no await before the row is inserted, so two creations can't both slip through. */
  const assertUploadLimits = (accountId: string, limits: UploadLimits): void => {
    const at = clock.now().getTime();
    const time = now();
    if (repository.countLive(time, accountId) >= limits.inProgressPerAccount) throw new TooManyUploadsError("in-progress-per-account");
    if (repository.countLive(time) >= limits.inProgressPerInstance) throw new TooManyUploadsError("in-progress-per-instance");
    const recent = recentCreations(accountId, at);
    if (recent.length >= limits.createdPerAccountPerHour) {
      const oldest = Math.min(...recent);
      throw new TooManyUploadsError("created-per-hour", Math.max(1, Math.ceil((oldest + HOUR_MS - at) / 1000)));
    }
  };

  /** The upload's target as recorded, checked again. */
  const targetOf = async (row: UploadRow, username: string): Promise<UploadTarget> => {
    const place: FilesPlace =
      row.targetResourceId === null ? { kind: "home", username } : { kind: "resource", resourceId: row.targetResourceId };
    return { place, folder: await folderAt(place, row.targetPath), name: row.fileName };
  };

  /** Drops an upload that can't complete: its staged bytes and its row. */
  const discard = async (uploadId: string): Promise<void> => {
    await staging.remove(uploadId);
    repository.delete(uploadId);
  };

  const usernameOf = (row: UploadRow): string => {
    const account = accounts.findById(row.accountId);
    if (account === undefined) throw new UploadNotFoundError();
    return account.username;
  };

  /** Removes the upload's `.nu-upload-*` file from its target, if one is recorded and still there. */
  const removeTemp = async (row: UploadRow): Promise<boolean> => {
    if (row.tempName === null) return false;
    const place: FilesPlace =
      row.targetResourceId === null ? { kind: "home", username: usernameOf(row) } : { kind: "resource", resourceId: row.targetResourceId };
    try {
      await remove(await resolveIn(place, childPath(row.targetPath, row.tempName)));
    } catch (error) {
      if (error instanceof PathRefusedError && error.reason === "not-found") return false;
      throw error;
    }
    return true;
  };

  /** Runs one cleanup step, logging its failure so the others still run. */
  const attempt = async (what: string, uploadId: string, step: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await step();
    } catch (error) {
      logger.warn({ err: error, uploadId }, `Upload cleanup could not ${what}`);
      return false;
    }
  };

  return {
    list: async (place, request) => listEntries(await resolveIn(place, request.path), request),

    async createFolder(place, parent, name) {
      const folder = await folderAt(place, parent);
      const checked = acceptName(name);
      try {
        await stat(await resolveInResource(folder.root, childPath(folder.relative, checked)));
        throw new NameTakenError();
      } catch (error) {
        if (error instanceof PathRefusedError && error.reason === "symlink") throw new NameTakenError();
        if (!(error instanceof PathRefusedError && error.reason === "not-found")) throw error;
      }
      return toEntry(await stat(await makeFolder(folder, checked)));
    },

    resolve: async (place, path) => resolveIn(place, path),

    async delete(place, { path, recursive }, actor, origin) {
      const target = await resolveIn(place, path);
      if (target.relative === "") throw new PathRefusedError("invalid");
      const entry = await stat(target);
      if (entry.kind === "folder" && !recursive && (await list(target)).length > 0) throw new FolderNotEmptyError();
      await remove(target);
      audit.record({
        action: "file.deleted",
        actor,
        outcome: "succeeded",
        origin,
        ...(place.kind === "resource" ? { target: { kind: "resource", id: place.resourceId } } : {}),
        details: {
          resourceId: place.kind === "resource" ? place.resourceId : null,
          path: target.relative,
          kind: entry.kind,
          recursive,
        },
      });
    },

    async quota(accountId, username) {
      const home = await resolveIn({ kind: "home", username }, "");
      return { usedBytes: (await usedBytes(home)) + repository.liveBytes(accountId, now()), limitBytes: quotaLimit(accountId) };
    },

    limits: () => settings.get("uploadLimits"),

    updateLimits(values, actor, origin) {
      if (!isDeepStrictEqual(settings.get("uploadLimits"), values)) {
        settings.set("uploadLimits", values, actor.accountId);
        audit.record({ action: "settings.changed", actor, outcome: "succeeded", origin, details: { keys: ["uploadLimits"] } });
      }
      return settings.get("uploadLimits");
    },

    assertOwnUpload(accountId, uploadId) {
      const row = repository.find(uploadId);
      if (row?.accountId !== accountId || row.expiresAt <= now()) throw new UploadNotFoundError();
    },

    async createUpload(caller, uploadId, metadata, size) {
      const wanted = parseMetadata(caller, metadata);
      const folder = await folderAt(wanted.place, wanted.folder);
      const target: UploadTarget = { place: wanted.place, folder, name: acceptName(wanted.name) };
      const limits = settings.get("uploadLimits");
      if (size > limits.maxFileBytes) throw new FileTooLargeError();
      assertUploadLimits(caller.accountId, limits);
      await assertNoConflict(target, wanted.onConflict);
      const homeBytes = await homeBytesOf(caller);
      assertQuota(caller, homeBytes, size);
      if (!leavesReserve(await probes.staging(), size, limits.diskReserve)) throw new InsufficientStorageError();
      await assertTargetReserve(folder, size, limits);
      // Checked again with no await before the insert: the awaits above let other creations in.
      assertUploadLimits(caller.accountId, limits);
      assertQuota(caller, homeBytes, size);
      const time = clock.now();
      repository.insert({
        id: uploadId,
        accountId: caller.accountId,
        targetResourceId: target.place.kind === "resource" ? target.place.resourceId : null,
        targetPath: folder.relative,
        fileName: target.name,
        size,
        offset: 0,
        stagedPath: staging.pathOf(uploadId),
        onConflict: wanted.onConflict,
        createdAt: time.toISOString(),
        lastChunkAt: time.toISOString(),
        expiresAt: new Date(time.getTime() + UPLOAD_EXPIRY_MS).toISOString(),
        tempName: null,
        completedAt: null,
      });
      creations.set(caller.accountId, [...recentCreations(caller.accountId, time.getTime()), time.getTime()]);
    },

    recordChunk(uploadId, offset) {
      const time = clock.now();
      repository.update(uploadId, {
        offset,
        lastChunkAt: time.toISOString(),
        expiresAt: new Date(time.getTime() + UPLOAD_EXPIRY_MS).toISOString(),
      });
    },

    async finishUpload(caller, uploadId, origin) {
      const row = repository.find(uploadId);
      if (row?.accountId !== caller.accountId) throw new UploadNotFoundError();
      let target: UploadTarget;
      try {
        target = await targetOf(row, caller.username);
        assertQuota(caller, await homeBytesOf(caller), row.size, uploadId);
        await assertNoConflict(target, row.onConflict);
        await assertTargetReserve(target.folder, row.size, settings.get("uploadLimits"));
      } catch (error) {
        if (refusalProblem(error) !== undefined) await discard(uploadId);
        throw error;
      }
      repository.update(uploadId, { tempName: `${TEMP_PREFIX}${uploadId}` });
      let placed: ContainedPath;
      try {
        placed = await moveIntoPlace({
          folder: target.folder,
          name: target.name,
          uploadId,
          content: staging.read(uploadId),
          onConflict: conflictRule[row.onConflict],
        });
      } catch (error) {
        // moveIntoPlace removed its temporary file. A name taken at the last moment drops the
        // upload; anything else keeps it, so the client can send its last (empty) chunk again.
        if (refusalProblem(error) !== undefined) await discard(uploadId);
        else repository.update(uploadId, { tempName: null });
        throw error;
      }
      await discard(uploadId);
      audit.record({
        action: "file.uploaded",
        actor: { kind: "account", accountId: caller.accountId, username: caller.username },
        outcome: "succeeded",
        origin,
        ...(target.place.kind === "resource" ? { target: { kind: "resource", id: target.place.resourceId } } : {}),
        details: {
          resourceId: target.place.kind === "resource" ? target.place.resourceId : null,
          path: placed.relative,
          size: row.size,
          onConflict: row.onConflict,
        },
      });
    },

    async cleanup() {
      const time = clock.now();
      let expired = 0;
      let tempFiles = 0;
      let orphans = 0;
      for (const row of repository.listExpired(time.toISOString())) {
        if (await attempt("remove a temporary file", row.id, () => removeTemp(row))) tempFiles += 1;
        const dropped = await attempt("drop an expired upload", row.id, async () => {
          await discard(row.id);
          return true;
        });
        if (dropped) expired += 1;
      }
      for (const row of repository.listStaleTemps(new Date(time.getTime() - TEMP_FILE_MAX_AGE_MS).toISOString())) {
        if (await attempt("remove a temporary file", row.id, () => removeTemp(row))) tempFiles += 1;
        repository.update(row.id, { tempName: null });
      }
      const known = new Set(repository.listIds());
      for (const id of await staging.list()) {
        if (known.has(id)) continue;
        const removed = await attempt("remove an orphan staged file", id, async () => {
          await staging.remove(id);
          return true;
        });
        if (removed) orphans += 1;
      }
      if (expired + tempFiles + orphans > 0) logger.info({ expired, tempFiles, orphans }, "Upload cleanup done");
      return { expired, tempFiles, orphans };
    },
  };
}
