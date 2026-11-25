import {
  DEFAULT_SHARE_LINK_EXPIRY_DAYS,
  problemTypes,
  shareLinkPath,
  type ChangeShareLinkRequest,
  type CreateShareLinkRequest,
  type ShareLink,
  type ShareLinkAccess,
  type ShareLinkAllowedUser,
  type ShareLinkDetail,
  type SharedWithMeLink,
  type SharedWithMePage,
  type ShareLinksPage,
  type ShareLinkState,
} from "@not-unreachable/contracts";
import { z } from "zod";
import { HttpProblem } from "../../http/index.ts";
import type { PasswordHasher } from "../accounts/index.ts";
import type { AuditActor, AuditOrigin, AuditService, AuditTarget } from "../audit/index.ts";
import { absoluteUrl, DAY_MS, hashToken, newId, newToken, type Clock, type EnvelopeAad, type Secrets } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import { PathRefusedError, resolveInResource, stat } from "../storage/index.ts";
import type { ShareLinksRepository, ShareLinksPosition } from "./repository.ts";
import type { ShareLinkRow } from "./schema.ts";

/** Who acts on the admin's routes, and from where, for the audit log. */
export interface AdminContext {
  readonly actor: AuditActor;
  readonly origin: AuditOrigin;
}

export interface ShareLinksQueryInput {
  readonly state?: ShareLinkState | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface SharedWithMeQueryInput {
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/** The admin's share links, and a user's Shared with me (threat model, T8). */
export interface ShareLinksService {
  /**
   * Reads the kind from the item (404 when missing, 422 for anything but a file or a folder), and 422
   * for a picked account that isn't a user's; records `share-link.created`.
   */
  create(request: CreateShareLinkRequest, context: AdminContext): Promise<ShareLinkDetail>;
  list(query: ShareLinksQueryInput): ShareLinksPage;
  get(id: string): ShareLinkDetail;
  /**
   * Any change of the password deletes every unlock; a change of the link access doesn't, and leaving
   * "Selected users" empties its list. Records `share-link.changed`.
   */
  change(id: string, request: ChangeShareLinkRequest, context: AdminContext): Promise<ShareLinkDetail>;
  /** Deletes the link's unlocks too; records `share-link.revoked` the first time. */
  revoke(id: string, context: AdminContext): ShareLink;
  /** The user's Shared with me: the active links they can open, as {@link ShareLinksRepository.listSharedWith} finds them. */
  listSharedWith(userId: string, query: SharedWithMeQueryInput): SharedWithMePage;
  /** The daily purge of expired unlocks; answers how many went. */
  purgeExpiredUnlocks(): number;
}

export interface ShareLinksServiceDependencies {
  readonly repository: ShareLinksRepository;
  readonly resources: Pick<ResourcesService, "rootFor" | "get">;
  readonly hasher: Pick<PasswordHasher, "hash">;
  readonly audit: AuditService;
  readonly clock: Clock;
  /** The master key's secrets, which the tokens' envelope copies need. */
  readonly secrets: Secrets | undefined;
  /** `PUBLIC_ORIGIN`, which every link is built from (threat model, T15). */
  readonly publicOrigin: string;
}

export const tokenAad = (id: string): EnvelopeAad => ({ table: "share_links", column: "token", rowId: id });

/** A link's state at `now`, as the repository's filters read it. */
export function stateOf(row: ShareLinkRow, now: Date): ShareLinkState {
  if (row.revokedAt !== null) return "revoked";
  return row.expiresAt !== null && Date.parse(row.expiresAt) <= now.getTime() ? "expired" : "active";
}

/** Whether the link is locked after wrong passwords at `now`. */
export function isLocked(row: ShareLinkRow, now: Date): boolean {
  return row.lockedUntil !== null && Date.parse(row.lockedUntil) > now.getTime();
}

/** The shared item's own name: the last segment of its path. */
export function nameOf(row: Pick<ShareLinkRow, "path">): string {
  return row.path.slice(row.path.lastIndexOf("/") + 1);
}

const cursorSchema = z.tuple([z.string(), z.string()]);

function encodeCursor(row: ShareLinkRow): string {
  return Buffer.from(JSON.stringify([row.createdAt, row.id])).toString("base64url");
}

function decodeCursor(cursor: string): ShareLinksPosition {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new HttpProblem(400, problemTypes.badRequest, "The cursor is not valid.");
  }
  const result = cursorSchema.safeParse(decoded);
  if (!result.success) throw new HttpProblem(400, problemTypes.badRequest, "The cursor is not valid.");
  const [createdAt, id] = result.data;
  return { createdAt, id };
}

/** One page of a list, newest first: one row more than `limit` is read to know whether another page follows. */
function pageOf(
  read: (after: ShareLinksPosition | undefined, count: number) => ShareLinkRow[],
  cursor: string | undefined,
  limit: number,
): { readonly page: ShareLinkRow[]; readonly nextCursor: string | null } {
  const rows = read(cursor === undefined ? undefined : decodeCursor(cursor), limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { page, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null };
}

const notFound = (): HttpProblem => new HttpProblem(404, problemTypes.notFound);

const target = (row: ShareLinkRow): AuditTarget => ({ kind: "share-link", id: row.id });

export function createShareLinksService({
  repository,
  resources,
  hasher,
  audit,
  clock,
  secrets,
  publicOrigin,
}: ShareLinksServiceDependencies): ShareLinksService {
  const requireSecrets = (): Secrets => {
    if (secrets === undefined) throw new Error("Share links need the master key");
    return secrets;
  };

  const toShareLink = (row: ShareLinkRow, resourceName: string, allowedUsers: ShareLinkAllowedUser[]): ShareLink => {
    const now = clock.now();
    const locked = isLocked(row, now);
    return {
      id: row.id,
      resourceId: row.resourceId,
      resourceName,
      path: row.path,
      name: nameOf(row),
      kind: row.kind,
      state: stateOf(row, now),
      hasPassword: row.passwordHash !== null,
      access: row.access,
      allowedUsers,
      expiresAt: row.expiresAt,
      noExpiry: row.expiresAt === null,
      lockedUntil: locked ? row.lockedUntil : null,
      locked,
      downloadCount: row.downloadCount,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
    };
  };

  const allowedUsersOf = (row: ShareLinkRow): ShareLinkAllowedUser[] => repository.allowedUsers([row.id]).get(row.id) ?? [];

  const shareLinkOf = (row: ShareLinkRow): ShareLink => toShareLink(row, resources.get(row.resourceId).name, allowedUsersOf(row));

  const linkFor = (token: string): string => absoluteUrl({ publicOrigin }, shareLinkPath(token));

  /** The link's whole URL, from the token's envelope copy. */
  const linkOf = (row: ShareLinkRow): string => linkFor(requireSecrets().decrypt("share-link", tokenAad(row.id), row.token));

  const detailOf = (row: ShareLinkRow): ShareLinkDetail => ({ shareLink: shareLinkOf(row), link: linkOf(row) });

  const toSharedWithMeLink = (row: ShareLinkRow): SharedWithMeLink => ({
    id: row.id,
    name: nameOf(row),
    kind: row.kind,
    expiresAt: row.expiresAt,
    hasPassword: row.passwordHash !== null,
    link: linkOf(row),
  });

  const find = (id: string): ShareLinkRow => {
    const row = repository.findById(id);
    if (row === undefined) throw notFound();
    return row;
  };

  /** The expiry a request asks for: none for "No expiry", the time given (in the future), or undefined to keep or default. */
  const expiryOf = (request: {
    readonly expiresAt?: string | undefined;
    readonly noExpiry?: true | undefined;
  }): string | null | undefined => {
    if (request.noExpiry === true) return null;
    if (request.expiresAt === undefined) return undefined;
    const at = Date.parse(request.expiresAt);
    if (at <= clock.now().getTime()) throw new HttpProblem(422, problemTypes.validationFailed, "The expiry must be in the future.");
    return new Date(at).toISOString();
  };

  /** The picked users, each once, in the order given; 422 unless every one is a user's (never the admin's, never unknown). */
  const allowedUserIdsOf = (request: { readonly allowedUserIds?: readonly string[] | undefined }): string[] => {
    const ids = [...new Set(request.allowedUserIds ?? [])];
    const roles = repository.rolesOf(ids);
    if (ids.some((userId) => roles.get(userId) !== "user")) {
      throw new HttpProblem(422, problemTypes.validationFailed, 'Pick only users\' accounts for "Selected users".');
    }
    return ids;
  };

  return {
    async create(request, { actor, origin }) {
      const expiry = expiryOf(request);
      const access: ShareLinkAccess = request.access ?? "anyone";
      const allowedUserIds = allowedUserIdsOf(request);
      const item = await resolveInResource(resources.rootFor(request.resourceId), request.path);
      if (item.relative === "") throw new PathRefusedError("invalid");
      const entry = await stat(item);
      if (entry.kind !== "file" && entry.kind !== "folder") throw new PathRefusedError("special-file");
      const passwordHash = request.password === undefined ? null : await hasher.hash(request.password);
      const id = newId(clock);
      const token = newToken();
      const now = clock.now();
      const row: ShareLinkRow = {
        id,
        tokenHash: hashToken(token),
        token: requireSecrets().encrypt("share-link", tokenAad(id), token),
        resourceId: request.resourceId,
        path: item.relative,
        kind: entry.kind,
        passwordHash,
        access,
        expiresAt: expiry === undefined ? new Date(now.getTime() + DEFAULT_SHARE_LINK_EXPIRY_DAYS * DAY_MS).toISOString() : expiry,
        lockedUntil: null,
        createdBy: actor.kind === "account" ? actor.accountId : null,
        createdAt: now.toISOString(),
        revokedAt: null,
        downloadCount: 0,
        lastUsedAt: null,
      };
      repository.transaction(() => {
        repository.insert(row);
        repository.replaceAllowedUsers(id, allowedUserIds);
      });
      audit.record({
        action: "share-link.created",
        actor,
        outcome: "succeeded",
        target: target(row),
        origin,
        details: {
          resourceId: row.resourceId,
          path: row.path,
          kind: row.kind,
          hasPassword: passwordHash !== null,
          expiresAt: row.expiresAt,
          access,
          allowedUserIds: allowedUsersOf(row).map((user) => user.id),
        },
      });
      return { shareLink: shareLinkOf(row), link: linkFor(token) };
    },

    list({ state, cursor, limit }) {
      const { page, nextCursor } = pageOf(
        (after, count) => repository.list({ state, now: clock.now().toISOString() }, after, count),
        cursor,
        limit,
      );
      const allowedUsers = repository.allowedUsers(page.map((row) => row.id));
      const names = new Map<string, string>();
      const nameFor = (resourceId: string): string => {
        let name = names.get(resourceId);
        if (name === undefined) {
          name = resources.get(resourceId).name;
          names.set(resourceId, name);
        }
        return name;
      };
      return {
        shareLinks: page.map((row) => toShareLink(row, nameFor(row.resourceId), allowedUsers.get(row.id) ?? [])),
        nextCursor,
      };
    },

    listSharedWith(userId, { cursor, limit }) {
      const { page, nextCursor } = pageOf(
        (after, count) => repository.listSharedWith(userId, clock.now().toISOString(), after, count),
        cursor,
        limit,
      );
      return { shareLinks: page.map(toSharedWithMeLink), nextCursor };
    },

    get: (id) => detailOf(find(id)),

    async change(id, request, { actor, origin }) {
      const before = find(id);
      if (before.revokedAt !== null) throw new HttpProblem(409, problemTypes.shareLinkRevoked);
      const expiry = expiryOf(request);
      const allowedUserIds = request.access === undefined ? undefined : allowedUserIdsOf(request);
      const usersBefore = allowedUsersOf(before).map((user) => user.id);
      const accessChanged =
        request.access !== undefined &&
        (request.access !== before.access ||
          allowedUserIds?.length !== usersBefore.length ||
          allowedUserIds.some((userId) => !usersBefore.includes(userId)));
      const passwordHash =
        request.password === undefined || request.password === null ? request.password : await hasher.hash(request.password);
      const unlocksDeleted = repository.transaction(() => {
        const changed = repository.change(id, {
          ...(expiry === undefined ? {} : { expiresAt: expiry }),
          ...(passwordHash === undefined ? {} : { passwordHash }),
          ...(request.access === undefined ? {} : { access: request.access }),
        });
        if (!changed) throw new HttpProblem(409, problemTypes.shareLinkRevoked);
        if (allowedUserIds !== undefined) repository.replaceAllowedUsers(id, allowedUserIds);
        return passwordHash === undefined ? 0 : repository.deleteUnlocks(id);
      });
      const after = find(id);
      const fields = [
        ...(expiry === undefined ? [] : ["expiry" as const]),
        ...(passwordHash === undefined ? [] : ["password" as const]),
        ...(accessChanged ? ["access" as const] : []),
      ];
      audit.record({
        action: "share-link.changed",
        actor,
        outcome: "succeeded",
        target: target(after),
        origin,
        details: {
          fields,
          hasPassword: after.passwordHash !== null,
          expiresAt: after.expiresAt,
          unlocksDeleted,
          access: after.access,
          allowedUserIds: allowedUsersOf(after).map((user) => user.id),
        },
      });
      return detailOf(after);
    },

    revoke(id, { actor, origin }) {
      find(id);
      const revoked = repository.transaction(() => {
        const done = repository.revoke(id, clock.now().toISOString());
        if (done) repository.deleteUnlocks(id);
        return done;
      });
      const row = find(id);
      if (revoked) audit.record({ action: "share-link.revoked", actor, outcome: "succeeded", target: target(row), origin, details: {} });
      return shareLinkOf(row);
    },

    purgeExpiredUnlocks: () => repository.purgeExpiredUnlocks(clock.now().toISOString()),
  };
}
