import { problemTypes, type AllowFolderRefusal, type AuditOutcome, type Reauthentication } from "@not-unreachable/contracts";
import type { ForbiddenRoots } from "@not-unreachable/mount-helper/folder-access";
import { HttpProblem, type Caller } from "../../http/index.ts";
import { actorOf, type AuditDetails, type AuditOrigin, type AuditService } from "../audit/index.ts";
import { MINUTE_MS, type Clock, type Logger } from "../platform/index.ts";
import { fixRoot as storageFixRoot, type FixedRoot } from "../storage/index.ts";
import type { FolderHelper, FolderHelperOutcome } from "./folder-helper.ts";
import { deleteFolderRequest, writeFolderRequest } from "./folder-requests.ts";
import { adminInterfaceRefusal, checkLocalFolderPath, type AllowFromUi } from "./local-folder.ts";

/**
 * Allowing a local folder from the admin interface (deployment.md, "Allowing folders from the admin
 * interface"), which only exists while `ALLOW_FOLDERS_FROM_UI` is on: what `sudo not-unreachable
 * allow-folder` does, through the root folder helper, after a fresh proof of both factors.
 */

/** Requests per admin account within the window, whatever they end in (threat model, T11). */
export const ALLOW_FOLDER_LIMIT = { max: 5, windowMs: 15 * MINUTE_MS } as const;

type AllowFolderResult = AuditDetails<"folder.allowed">["result"];

/** Where the request came from; `request.requestContext` is one. */
export interface AllowFolderOrigin extends AuditOrigin {
  readonly ip: string;
}

/**
 * `SignInService.reauthenticate`: the password, then the second factor, under the sign-in limits.
 * The composition root hands it in, as `sign-in` sits in a layer above this module (domain.md).
 */
export type Reauthenticate = (caller: Caller, reauthentication: Reauthentication, origin: AllowFolderOrigin) => Promise<void>;

/** Emails the account holder that a folder was allowed (second-factors' security notices), handed in likewise. */
export type NotifyFolderAllowed = (accountId: string, realPath: string) => void;

export interface AllowedFoldersService {
  /**
   * Checks the limit (429 `rate-limited`), the password and second factor ({@link Reauthenticate}), then the folder (422 `folder-not-allowable`, 409 when the
   * service can write to it already), and has the helper allow it (503 when the helper isn't set
   * up, 500 when it failed). Records one `folder.allowed` either way; on success, the service
   * restarts 3 seconds later.
   */
  allow(caller: Caller, localPath: string, reauthentication: Reauthentication, origin: AllowFolderOrigin): Promise<void>;
}

export interface AllowedFoldersDependencies {
  readonly forbiddenRoots: ForbiddenRoots;
  readonly allowFromUi: AllowFromUi;
  /** Where the helper's request file is written. */
  readonly requestsDir: string;
  readonly helper: FolderHelper;
  readonly reauthenticate: Reauthenticate;
  readonly audit: AuditService;
  readonly notifyFolderAllowed: NotifyFolderAllowed;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `storage.fixRoot` unless given; tests pass one that answers `not-writable`. */
  readonly fixRoot?: (absolute: string) => Promise<FixedRoot>;
}

/** Why the folder can't be allowed, as the admin reads it; never the path (problem bodies hold none). */
const refusalDetails: Record<AllowFolderRefusal, string> = {
  "not-absolute": "The path must be absolute (start with /).",
  missing: "No such folder exists.",
  "not-a-folder": "That path is not a folder.",
  "inside-data-directory": "The folder overlaps the service's data directory.",
  "inside-release-directory": "The folder overlaps the service's release directory.",
  "inside-mount-root": "The folder overlaps the folder SMB shares are mounted in.",
  "outside-allowed-folders":
    "The folder is outside the folders the admin interface may allow (ALLOWED_FOLDER_PREFIXES). Run sudo not-unreachable allow-folder on the server instead.",
  "system-folder":
    "The folder is, holds or is inside a folder of the operating system, which the admin interface never allows. Run sudo not-unreachable allow-folder on the server instead.",
  "unsupported-path": "The folder's path holds a backslash, a double quote or a control character, which the systemd drop-in can't list.",
  "overlaps-allowed-folder":
    "The folder lies inside or holds a folder the service can already write to, which the admin interface never allows. Run sudo not-unreachable allow-folder on the server instead.",
};

const HELPER_UNAVAILABLE =
  "The server isn't set up to allow folders from the admin interface. Run sudo not-unreachable allow-folders-from-ui on there, or allow the folder with sudo not-unreachable allow-folder.";

/** A failed proof's problem, as `folder.allowed` records it; undefined for any other error. */
function proofFailure(error: unknown): { readonly result: AllowFolderResult; readonly outcome: AuditOutcome } | undefined {
  if (!(error instanceof HttpProblem)) return undefined;
  if (error.type === problemTypes.signInFailed) return { result: "wrong-password", outcome: "failed" };
  if (error.type === problemTypes.secondFactorFailed) return { result: "wrong-second-factor", outcome: "failed" };
  if (error.status === 429) return { result: "too-many-attempts", outcome: "denied" };
  return undefined;
}

/** A refused request: its audit record and the problem it answers. */
class Refused extends Error {
  override readonly name = "Refused";
  readonly result: AllowFolderResult;
  readonly outcome: AuditOutcome;
  readonly realPath: string | null;
  readonly problem: HttpProblem;

  constructor(result: AllowFolderResult, outcome: AuditOutcome, realPath: string | null, problem: HttpProblem) {
    super(problem.message);
    this.result = result;
    this.outcome = outcome;
    this.realPath = realPath;
    this.problem = problem;
  }
}

function notAllowable(reason: AllowFolderRefusal, realPath: string | null): Refused {
  return new Refused(
    reason,
    "denied",
    realPath,
    new HttpProblem(422, problemTypes.folderNotAllowable, refusalDetails[reason], {}, { reason }),
  );
}

function helperFailed(realPath: string): Refused {
  return new Refused("helper-failed", "failed", realPath, new HttpProblem(500, problemTypes.internalError));
}

export function createAllowedFoldersService({
  forbiddenRoots,
  allowFromUi,
  requestsDir,
  helper,
  reauthenticate: proveBothFactors,
  audit,
  notifyFolderAllowed,
  clock,
  logger,
  fixRoot = storageFixRoot,
}: AllowedFoldersDependencies): AllowedFoldersService {
  /** Request times per account within the window, oldest first; in memory, as the app is one process. */
  const requests = new Map<string, number[]>();

  /** Counts the request; throws past the limit. Admin accounts are few, so the map stays small. */
  const countRequest = (accountId: string): void => {
    const now = clock.now().getTime();
    const recent = (requests.get(accountId) ?? []).filter((at) => at > now - ALLOW_FOLDER_LIMIT.windowMs);
    requests.set(accountId, recent);
    if (recent.length < ALLOW_FOLDER_LIMIT.max) {
      recent.push(now);
      return;
    }
    const retryAt = (recent[recent.length - ALLOW_FOLDER_LIMIT.max] ?? now) + ALLOW_FOLDER_LIMIT.windowMs;
    const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
    throw new Refused(
      "rate-limited",
      "denied",
      null,
      new HttpProblem(429, problemTypes.rateLimited, "Too many tries to allow a folder. Try again later.", {
        "retry-after": String(seconds),
      }),
    );
  };

  const reauthenticate = async (caller: Caller, reauthentication: Reauthentication, origin: AllowFolderOrigin): Promise<void> => {
    try {
      await proveBothFactors(caller, reauthentication, origin);
    } catch (error) {
      const failure = proofFailure(error);
      if (failure === undefined || !(error instanceof HttpProblem)) throw error;
      throw new Refused(failure.result, failure.outcome, null, error);
    }
  };

  /** The folder's real path once it passes `allow-folder`'s rules and the admin interface's own. */
  const checkFolder = async (localPath: string): Promise<string> => {
    const checked = await checkLocalFolderPath(localPath, forbiddenRoots);
    if (!checked.ok) throw notAllowable(checked.reason, null);
    // Only after the overlap checks: the write probe never lands in the service's own folders.
    const fixed = await fixRoot(localPath);
    if (fixed.ok) {
      throw new Refused(
        "already-writable",
        "denied",
        fixed.realPath,
        new HttpProblem(409, problemTypes.badRequest, "The service can already write to this folder."),
      );
    }
    if (fixed.reason !== "not-writable") throw notAllowable(fixed.reason, null);
    const refusal = await adminInterfaceRefusal(checked.canonical, allowFromUi, forbiddenRoots);
    if (refusal !== undefined) throw notAllowable(refusal, checked.canonical);
    return checked.canonical;
  };

  /** The helper's run over the request file, which is deleted however it ends. */
  const allowByHelper = async (localPath: string, realPath: string): Promise<FolderHelperOutcome> => {
    try {
      await writeFolderRequest(requestsDir, localPath);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "The folder helper's request couldn't be written");
      throw helperFailed(realPath);
    }
    try {
      return await helper.allow();
    } finally {
      // The next request deletes a stale one first, so a failed delete doesn't change the outcome.
      await deleteFolderRequest(requestsDir).catch((error: unknown) => {
        logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "The folder helper's request couldn't be deleted");
      });
    }
  };

  // One run at a time: there is one request file, which a second request would overwrite mid-run.
  let lastRun: Promise<unknown> = Promise.resolve();
  const runHelper = async (localPath: string, realPath: string): Promise<void> => {
    const run = lastRun.then(async () => allowByHelper(localPath, realPath));
    lastRun = run.catch(() => undefined);
    const outcome = await run;
    if (outcome.ok) return;
    if (outcome.reason === "helper-unavailable") {
      throw new Refused(
        "helper-unavailable",
        "failed",
        realPath,
        new HttpProblem(503, problemTypes.serviceUnavailable, HELPER_UNAVAILABLE),
      );
    }
    if (outcome.reason === "helper-failed") throw helperFailed(realPath);
    throw notAllowable(outcome.reason, realPath);
  };

  const record = (caller: Caller, origin: AllowFolderOrigin, outcome: AuditOutcome, details: AuditDetails<"folder.allowed">): void => {
    audit.record({ action: "folder.allowed", actor: actorOf(caller), outcome, origin, details });
  };

  return {
    async allow(caller, localPath, reauthentication, origin) {
      let realPath: string;
      let checkedPath: string | null = null;
      try {
        countRequest(caller.accountId);
        // Before the folder is looked at: without both factors, nothing tells whether a path exists.
        await reauthenticate(caller, reauthentication, origin);
        realPath = await checkFolder(localPath);
        checkedPath = realPath;
        await runHelper(localPath, realPath);
      } catch (error) {
        // Every request is recorded, one that ends in an unexpected error too.
        if (!(error instanceof Refused)) {
          record(caller, origin, "failed", { path: localPath, realPath: checkedPath, result: "error" });
          throw error;
        }
        record(caller, origin, error.outcome, { path: localPath, realPath: error.realPath, result: error.result });
        throw error.problem;
      }
      record(caller, origin, "succeeded", { path: localPath, realPath, result: "allowed" });
      logger.info({ accountId: caller.accountId }, "A folder was allowed from the admin interface; the service restarts in 3 seconds");
      // Fire and forget: the mail may still be on its way when the service restarts, and is then lost.
      notifyFolderAllowed(caller.accountId, realPath);
    },
  };
}
