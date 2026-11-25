import { problemTypes, type EntriesPage, type PublicShareLink } from "@not-unreachable/contracts";
import { HttpProblem, type Caller } from "../../http/index.ts";
import type { PasswordHasher } from "../accounts/index.ts";
import { actorOf, type AuditActor, type AuditOrigin, type AuditService, type AuditTarget } from "../audit/index.ts";
import { listEntries, type EntriesRequest } from "../files/index.ts";
import { hashToken, newId, newToken, TOKEN_PATTERN, type Clock } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import { resolveInResource, stat, type ContainedPath, type Entry, type RealPath } from "../storage/index.ts";
import { type DownloadSlots, type ShareTokenLimit, type WrongPasswordCounter } from "./limits.ts";
import type { ShareLinksRepository } from "./repository.ts";
import type { ShareLinkRow } from "./schema.ts";
import { isLocked, nameOf, stateOf } from "./service.ts";
import { readUnlockToken, unlockCookie } from "./unlock-cookie.ts";

/** An unlock lasts this long, or until the link expires, whichever comes first. */
export const UNLOCK_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** What a public request brings: where it came from, its `Cookie` header for the unlock, and who is signed in. */
export interface ShareRequest {
  readonly origin: AuditOrigin;
  readonly cookieHeader: string | undefined;
  /** The session guard's caller, for the link access; null when signed out. */
  readonly caller: Caller | null;
}

/** A file a share link serves, checked on this very request. */
export interface SharedFile {
  readonly link: ShareLinkRow;
  readonly file: ContainedPath;
  /** Relative to the shared folder; empty for a file link's own file. */
  readonly path: string;
}

/**
 * The public share API (threat model, T8). Every call checks the token, the state, the item, the
 * link access and the unlock again, a download's every range request included.
 */
export interface PublicShareLinks {
  describe(token: string, request: ShareRequest): Promise<PublicShareLink>;
  /** Answers the `Set-Cookie` of a new unlock. */
  unlock(token: string, password: string, request: ShareRequest): Promise<string>;
  /** A folder link only; `path` is relative to the shared folder, which is the T5 root. */
  entries(token: string, query: EntriesRequest, request: ShareRequest): Promise<EntriesPage>;
  /** A file link serves only its own file (an empty path). */
  file(token: string, path: string, request: ShareRequest): Promise<SharedFile>;
  /** Takes one of the link's download slots for the request's IP (4 by default); answers its release. */
  startDownload(shared: SharedFile, request: ShareRequest): () => void;
  /** One more download of the link; records `share-link.downloaded`. */
  countDownload(shared: SharedFile, request: ShareRequest): void;
}

export interface PublicShareLinksDependencies {
  readonly repository: ShareLinksRepository;
  readonly resources: Pick<ResourcesService, "rootFor">;
  readonly hasher: Pick<PasswordHasher, "verify" | "verifyDummy">;
  readonly audit: AuditService;
  readonly clock: Clock;
  readonly tokenLimit: ShareTokenLimit;
  readonly wrongPasswords: WrongPasswordCounter;
  readonly downloads: DownloadSlots;
}

/** An open link: its row and its item, as they are now. */
interface OpenLink {
  readonly row: ShareLinkRow;
  readonly item: ContainedPath;
  readonly entry: Entry;
}

/**
 * Every invalid link, whatever the reason (unknown, malformed, expired, revoked, its item gone),
 * gets this very answer: the same status, title and no detail.
 */
const invalidLink = (): HttpProblem => new HttpProblem(404, problemTypes.shareLinkInvalid);

const passwordRequired = (): HttpProblem => new HttpProblem(401, problemTypes.shareLinkPasswordRequired);

/** Neither answer of the link access tells anything about the item. */
const signInRequired = (): HttpProblem => new HttpProblem(401, problemTypes.shareLinkSignInRequired);
const notAllowed = (): HttpProblem => new HttpProblem(403, problemTypes.shareLinkNotAllowed);

const linkTarget = (row: ShareLinkRow): AuditTarget => ({ kind: "share-link", id: row.id });

/** A folder link's folder as the T5 root, so nothing above it is reachable. */
const folderRoot = (link: OpenLink): RealPath => link.item.absolute;

export function createPublicShareLinks({
  repository,
  resources,
  hasher,
  audit,
  clock,
  tokenLimit,
  wrongPasswords,
  downloads,
}: PublicShareLinksDependencies): PublicShareLinks {
  /** The item the link names, if it still is what it was when the link was made. */
  const itemOf = async (row: ShareLinkRow): Promise<{ item: ContainedPath; entry: Entry } | undefined> => {
    try {
      const item = await resolveInResource(resources.rootFor(row.resourceId), row.path);
      const entry = await stat(item);
      return entry.kind === row.kind ? { item, entry } : undefined;
    } catch {
      // A missing resource or item, an unavailable resource, a symlink swapped in: all just "gone".
      return undefined;
    }
  };

  const open = async (token: string, { origin }: ShareRequest): Promise<OpenLink> => {
    const row = TOKEN_PATTERN.test(token) ? repository.findByTokenHash(hashToken(token)) : undefined;
    const found = row !== undefined && stateOf(row, clock.now()) === "active" ? await itemOf(row) : undefined;
    if (row === undefined || found === undefined) {
      tokenLimit.recordInvalid(origin);
      throw invalidLink();
    }
    return { row, ...found };
  };

  /**
   * The link access, right after the token: "Signed-in users" needs a fully signed-in caller (a
   * session pending its second factor isn't one), and "Selected users" the admin or a listed user.
   */
  const checkAccess = (row: ShareLinkRow, caller: Caller | null): void => {
    if (row.access === "anyone") return;
    if (caller === null || caller.state !== "active") throw signInRequired();
    if (row.access === "selected-users" && caller.role !== "admin" && !repository.isAllowed(row.id, caller.accountId)) {
      throw notAllowed();
    }
  };

  /** An open link the request's caller may reach, password aside. */
  const openAllowed = async (token: string, request: ShareRequest): Promise<OpenLink> => {
    const link = await open(token, request);
    checkAccess(link.row, request.caller);
    return link;
  };

  const isUnlocked = (row: ShareLinkRow, cookieHeader: string | undefined): boolean => {
    if (row.passwordHash === null) return true;
    const unlock = readUnlockToken(cookieHeader, row.id);
    return unlock !== undefined && repository.hasUnlock(row.id, hashToken(unlock), clock.now().toISOString());
  };

  /** An open link the request may reach: allowed, and unlocked when it has a password. */
  const openUnlocked = async (token: string, request: ShareRequest): Promise<OpenLink> => {
    const link = await openAllowed(token, request);
    if (!isUnlocked(link.row, request.cookieHeader)) throw passwordRequired();
    return link;
  };

  const lockedProblem = (row: ShareLinkRow): HttpProblem => {
    const seconds = Math.max(1, Math.ceil((Date.parse(row.lockedUntil ?? "") - clock.now().getTime()) / 1000));
    return new HttpProblem(429, problemTypes.tooManyAttempts, undefined, { "retry-after": String(seconds) });
  };

  /** Records the wrong password, and locks the link once a limit is reached. */
  const refuseWrongPassword = (row: ShareLinkRow, origin: AuditOrigin): HttpProblem => {
    const lock = wrongPasswords.record(row.id, origin.ip);
    audit.record({
      action: "share-link.password-failed",
      actor: { kind: "anonymous" },
      outcome: "failed",
      target: linkTarget(row),
      origin,
      details: { limitReached: lock !== undefined },
    });
    if (lock === undefined) return new HttpProblem(401, problemTypes.shareLinkPasswordWrong);
    const until = lock.until.toISOString();
    repository.lock(row.id, until);
    audit.record({
      action: "share-link.locked",
      actor: { kind: "anonymous" },
      outcome: "denied",
      target: linkTarget(row),
      origin,
      details: { reason: lock.reason, lockedUntil: until },
    });
    return lockedProblem({ ...row, lockedUntil: until });
  };

  return {
    async describe(token, request) {
      const { row, entry } = await openAllowed(token, request);
      return {
        name: nameOf(row),
        kind: row.kind,
        size: row.kind === "file" ? entry.size : null,
        expiresAt: row.expiresAt,
        passwordRequired: !isUnlocked(row, request.cookieHeader),
      };
    },

    async unlock(token, password, request) {
      const { row } = await openAllowed(token, request);
      if (row.passwordHash === null) throw new HttpProblem(409, problemTypes.badRequest, "This link has no password.");
      if (isLocked(row, clock.now())) {
        // The same work as a real check, so a locked link can't be told from a wrong password by timing alone.
        await hasher.verifyDummy(password);
        throw lockedProblem(row);
      }
      const correct = await hasher.verify(row.passwordHash, password);
      // The password may have changed while it was checked: an unlock must never outlive that change.
      const now = repository.findById(row.id);
      if (now === undefined || now.passwordHash !== row.passwordHash || stateOf(now, clock.now()) !== "active") throw invalidLink();
      if (!correct) throw refuseWrongPassword(now, request.origin);
      if (isLocked(now, clock.now())) throw lockedProblem(now);
      const unlockToken = newToken();
      const at = clock.now().getTime();
      const expiresAt = Math.min(at + UNLOCK_LIFETIME_MS, now.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(now.expiresAt));
      repository.insertUnlock({
        id: newId(clock),
        shareLinkId: now.id,
        unlockHash: hashToken(unlockToken),
        expiresAt: new Date(expiresAt).toISOString(),
      });
      return unlockCookie(now.id, unlockToken, Math.max(1, Math.floor((expiresAt - at) / 1000)));
    },

    async entries(token, query, request) {
      const link = await openUnlocked(token, request);
      if (link.row.kind !== "folder") throw invalidLink();
      return listEntries(await resolveInResource(folderRoot(link), query.path), query);
    },

    async file(token, path, request) {
      const link = await openUnlocked(token, request);
      if (link.row.kind === "file") {
        if (path !== "") throw new HttpProblem(404, problemTypes.notFound);
        return { link: link.row, file: link.item, path: "" };
      }
      const file = await resolveInResource(folderRoot(link), path);
      if ((await stat(file)).kind !== "file") throw new HttpProblem(404, problemTypes.notFound);
      return { link: link.row, file, path: file.relative };
    },

    startDownload: (shared, { origin }) => downloads.acquire(shared.link.id, origin.ip),

    countDownload(shared, { origin, caller }) {
      repository.countDownload(shared.link.id, clock.now().toISOString());
      // A link only signed-in accounts open names who downloaded; checkAccess let only an active caller this far.
      const actor: AuditActor = shared.link.access !== "anyone" && caller !== null ? actorOf(caller) : { kind: "share-link" };
      audit.record({
        action: "share-link.downloaded",
        actor,
        outcome: "succeeded",
        target: linkTarget(shared.link),
        origin,
        details: { path: shared.path },
      });
    },
  };
}
