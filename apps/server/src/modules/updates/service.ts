import {
  problemTypes,
  UPDATE_FROM_UI_ON_COMMAND,
  updateReasons,
  type LatestRelease,
  type Reauthentication,
  type Update,
  type UpdateReason,
  type UpdateRequested,
  type UpdateResult,
  type UpdatesOverview,
  type UpdateStatusFile,
} from "@not-unreachable/contracts";
import {
  CHECKSUMS_FILE,
  checkChecksum,
  compareVersions,
  isReleaseVersion,
  MAX_CHECKSUMS_FILE_BYTES,
  MAX_SIGNATURE_FILE_BYTES,
  MAX_TARBALL_BYTES,
  parseChecksums,
  readTrustedKeys,
  releaseArchitecture,
  ReleaseVerifyError,
  SIGNATURE_FILE,
  tarballName,
  verifyChecksumsSignature,
  type ReleaseArchitecture,
} from "@not-unreachable/mount-helper/release-verify";
import { HttpProblem, type Caller } from "../../http/index.ts";
import { actorOf, type AuditOrigin, type AuditService } from "../audit/index.ts";
import type { MailTemplate } from "../mail/index.ts";
import { MINUTE_MS, newId, type Clock, type Logger } from "../platform/index.ts";
import { DownloadError, fetchLatestRelease, keptReleaseSchema, openDownload, type KeptRelease, type UpdatesFetch } from "./github.ts";
import type { UpdateHelper } from "./helper.ts";
import type { UpdatesRepository } from "./repository.ts";
import type { UpdateRequestRow } from "./schema.ts";
import {
  deleteUpdateRequest,
  emptySpool,
  readSpoolFile,
  readStatusFile,
  writeSpoolFile,
  writeUpdateRequest,
  type StatusFileRead,
} from "./spool.ts";

/**
 * Updating from Settings (deployment.md, "Updating from Settings"; threat model, T17): the check
 * for new releases, and, while `UPDATE_FROM_UI` is on, downloading the latest one for the root
 * update helper after a fresh proof of both factors.
 */

const HOUR_MS = 60 * MINUTE_MS;
/** How long a kept answer is good for; the scheduled check comes this long after the last, ± the jitter. */
export const CHECK_INTERVAL_MS = 6 * HOUR_MS;
export const CHECK_JITTER_MS = 30 * MINUTE_MS;
/** The first check after a start, when the kept answer is too old: 1 to 5 minutes, so restarts don't line up. */
export const FIRST_CHECK_MS = { min: MINUTE_MS, max: 5 * MINUTE_MS } as const;
/** **Check now**, for the instance. */
export const CHECK_NOW_LIMITS = [
  { max: 1, windowMs: MINUTE_MS },
  { max: 10, windowMs: HOUR_MS },
] as const;
/** Install requests per admin account within the window, whatever they end in (threat model, T11, T17). */
export const INSTALL_LIMIT = { max: 5, windowMs: 15 * MINUTE_MS } as const;
/** The one-line installer of docs/install.md, to update over SSH instead. */
export const INSTALLER_COMMAND = "curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh | sudo bash";

/** Where the request came from; `request.requestContext` is one. */
export interface UpdateOrigin extends AuditOrigin {
  readonly ip: string;
}

/**
 * `SignInService.reauthenticate`: the password, then the second factor, under the sign-in limits.
 * The composition root hands it in, as `sign-in` sits in a layer above this module (domain.md).
 */
export type Reauthenticate = (caller: Caller, reauthentication: Reauthentication, origin: UpdateOrigin) => Promise<void>;

/** Emails the account holder, once SMTP is set up; fire and forget. */
export type NotifyAccount = (accountId: string, template: MailTemplate) => void;

export interface UpdatesService {
  /** `UPDATE_CHECK`. */
  readonly checkEnabled: boolean;
  /** `UPDATE_FROM_UI`. */
  readonly installEnabled: boolean;
  /** What Settings → Updates shows; records `update.finished` for any update it sees finished. */
  overview(): Promise<UpdatesOverview>;
  /** **Check now**: asks GitHub (429 past {@link CHECK_NOW_LIMITS}), then the overview, also when the check failed. */
  checkNow(): Promise<UpdatesOverview>;
  /** The scheduled check: asks GitHub when it is due; nothing while `UPDATE_CHECK` is off. */
  checkIfDue(): Promise<void>;
  /** Records `update.finished` for every accepted request a server sees finished first (at startup too). */
  recordFinished(): Promise<void>;
  /**
   * Checks the limit (429), both factors (401), that the version is the latest installable release
   * and no update runs (409), then answers the request id; the download and the helper go on after.
   * Records one `update.requested` for every call.
   */
  install(caller: Caller, version: string, reauthentication: Reauthentication, origin: UpdateOrigin): Promise<UpdateRequested>;
  /** Resolves once the current install's background run has ended; for tests. */
  settled(): Promise<void>;
}

export interface UpdatesPaths {
  /** `DATA_DIR/updates`. */
  readonly spoolDir: string;
  /** Where the helper's request file is written. */
  readonly requestsDir: string;
  /** The helper's status file. */
  readonly statusFile: string;
  /** The running release's pinned keys, for the early check. */
  readonly trustedKeysDir: string;
}

export interface UpdatesServiceDependencies {
  readonly checkEnabled: boolean;
  readonly installEnabled: boolean;
  /** The server's own version. */
  readonly runningVersion: string;
  /** `process.arch`. */
  readonly arch: string;
  readonly repository: UpdatesRepository;
  readonly fetch: UpdatesFetch;
  readonly helper: UpdateHelper;
  readonly paths: UpdatesPaths;
  readonly reauthenticate: Reauthenticate;
  readonly audit: AuditService;
  readonly notify: NotifyAccount;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `Math.random` unless given: the jitter of the scheduled check. */
  readonly random?: () => number;
}

/** The reasons' words in an email; the admin interface has its own. */
const REASON_WORDS: Partial<Record<UpdateReason, string>> = {
  "installer-failed": "the new release's installer failed",
  "start-failed": "the new release didn't start",
  unhealthy: "the new release didn't stay healthy",
  internal: "something unexpected went wrong",
};

/** How the latest release can't be installed, if it can't. */
export function notInstallableBecause(
  release: Pick<KeptRelease, "version" | "assets">,
  runningVersion: string,
  arch: ReleaseArchitecture | undefined,
): LatestRelease["notInstallableBecause"] {
  if (!isReleaseVersion(runningVersion) || compareVersions(release.version, runningVersion) <= 0) return "not-newer";
  if (arch === undefined || !release.assets.includes(tarballName(release.version, arch))) return "no-tarball";
  if (!release.assets.includes(CHECKSUMS_FILE) || !release.assets.includes(SIGNATURE_FILE)) return "unsigned";
  return null;
}

/** A reason the database kept; `internal` for anything else, which only a hand-edited row could hold. */
function storedReason(value: string | null): UpdateReason {
  return updateReasons.find((reason) => reason === value) ?? "internal";
}

/** A refused install request: its audit outcome and the problem it answers. */
class Refused extends Error {
  override readonly name = "Refused";
  readonly outcome: "denied" | "refused";
  readonly problem: HttpProblem;

  constructor(outcome: "denied" | "refused", problem: HttpProblem) {
    super(problem.message);
    this.outcome = outcome;
    this.problem = problem;
  }
}

/** The time a window of requests opens again, or undefined while there's room; drops the old ones. */
function retryAt(times: number[], max: number, windowMs: number, now: number): number | undefined {
  while (times.length > 0 && (times[0] ?? now) <= now - windowMs) times.shift();
  if (times.length < max) return undefined;
  return (times[times.length - max] ?? now) + windowMs;
}

function rateLimited(retryAtMs: number, now: number, detail: string): HttpProblem {
  const seconds = Math.max(1, Math.ceil((retryAtMs - now) / 1000));
  return new HttpProblem(429, problemTypes.rateLimited, detail, { "retry-after": String(seconds) });
}

/** The kept release, if GitHub answered once and it still reads as one (a later schema change drops it). */
function keptRelease(release: string | null | undefined): KeptRelease | undefined {
  if (release === null || release === undefined) return undefined;
  try {
    const parsed = keptReleaseSchema.safeParse(JSON.parse(release));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The status file's status when it is about this request; a file that doesn't parse is about none. */
function statusOf(row: Pick<UpdateRequestRow, "requestId">, read: StatusFileRead): UpdateStatusFile | undefined {
  return read.kind === "known" && read.status.requestId === row.requestId ? read.status : undefined;
}

function fromStatus(base: Pick<Update, "requestId" | "from" | "to" | "startedAt">, status: UpdateStatusFile): Update {
  return { ...base, phase: status.phase, result: status.result, reason: status.reason, finishedAt: status.finishedAt };
}

/** The current download, kept in memory only: a restart during it ends the update as `download-failed`. */
interface ActiveUpdate {
  readonly requestId: string;
  readonly from: string;
  readonly to: string;
  readonly startedAt: string;
}

/** How a request ended, as `update.finished` records it. */
interface Finish {
  readonly result: UpdateResult;
  readonly reason: UpdateReason | null;
  readonly signingKey: string | null;
}

export function createUpdatesServiceWith({
  checkEnabled,
  installEnabled,
  runningVersion,
  arch: nodeArch,
  repository,
  fetch,
  helper,
  paths,
  reauthenticate,
  audit,
  notify,
  clock,
  logger,
  random = Math.random,
}: UpdatesServiceDependencies): UpdatesService {
  const arch = releaseArchitecture(nodeArch);
  const nowMs = (): number => clock.now().getTime();
  const nowIso = (): string => clock.now().toISOString();

  // --- The check -------------------------------------------------------------------------------

  const latestRelease = (): KeptRelease | undefined => keptRelease(repository.findCheck()?.release);

  const nextRegularCheck = (from: number): number => from + CHECK_INTERVAL_MS + Math.round((random() * 2 - 1) * CHECK_JITTER_MS);

  /** When the scheduled check is due: soon after a start when the kept answer is old, else 6 hours after the last try. */
  let nextCheckAt = ((): number => {
    const check = repository.findCheck();
    const tries = [check?.checkedAt, check?.failedAt].filter((at) => at !== null && at !== undefined).map((at) => Date.parse(at));
    const lastTry = tries.length === 0 ? undefined : Math.max(...tries);
    const now = nowMs();
    if (lastTry === undefined || now - lastTry >= CHECK_INTERVAL_MS) {
      return now + FIRST_CHECK_MS.min + Math.round(random() * (FIRST_CHECK_MS.max - FIRST_CHECK_MS.min));
    }
    return nextRegularCheck(lastTry);
  })();

  let checking: Promise<void> | undefined;
  /** Asks GitHub once; a check already on its way is shared. A failure keeps the last good answer. */
  const askGitHub = async (): Promise<void> => {
    checking ??= (async () => {
      try {
        const release = await fetchLatestRelease(fetch);
        repository.saveAnswer(JSON.stringify(release), nowIso());
        logger.info({ latest: release.version }, "GitHub answered the release check");
      } catch (error) {
        repository.saveFailure(nowIso());
        logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "The release check failed");
      } finally {
        nextCheckAt = nextRegularCheck(nowMs());
        checking = undefined;
      }
    })();
    return checking;
  };

  const checkNowTimes: number[] = [];
  const countCheckNow = (): void => {
    const now = nowMs();
    const retry = CHECK_NOW_LIMITS.map(({ max, windowMs }) => retryAt([...checkNowTimes], max, windowMs, now)).filter(
      (at) => at !== undefined,
    );
    if (retry.length > 0) throw rateLimited(Math.max(...retry), now, "The server checked for new releases a moment ago. Try again later.");
    checkNowTimes.push(now);
    // Only the longest window matters for what's kept.
    retryAt(checkNowTimes, Number.POSITIVE_INFINITY, HOUR_MS, now);
  };

  const checkOverview = (): UpdatesOverview["check"] => {
    if (!checkEnabled) return { enabled: false };
    const check = repository.findCheck();
    const release = keptRelease(check?.release);
    const because = release === undefined ? null : notInstallableBecause(release, runningVersion, arch);
    return {
      enabled: true,
      checkedAt: check?.checkedAt ?? null,
      failedAt: check?.failedAt ?? null,
      latest:
        release === undefined
          ? null
          : {
              version: release.version,
              publishedAt: release.publishedAt,
              releaseNotesUrl: release.releaseNotesUrl,
              installable: because === null,
              notInstallableBecause: because,
            },
    };
  };

  // --- Finished updates ------------------------------------------------------------------------

  let active: ActiveUpdate | undefined;
  let running: Promise<void> = Promise.resolve();

  const recordFinish = (row: UpdateRequestRow, finish: Finish): void => {
    // The claim and the event in one transaction: an event that fails leaves the request to record again.
    const claimed = repository.transaction(() => {
      if (!repository.claimRecording(row.requestId, nowIso())) return false;
      audit.record({
        action: "update.finished",
        actor: { kind: "account", accountId: row.accountId, username: row.username },
        outcome: finish.result === "succeeded" ? "succeeded" : "failed",
        details: {
          requestId: row.requestId,
          from: row.fromVersion,
          to: row.toVersion,
          result: finish.result,
          reason: finish.reason,
          signingKey: finish.signingKey,
        },
      });
      return true;
    });
    if (!claimed) return;
    logger.info(
      { from: row.fromVersion, to: row.toVersion, result: finish.result, reason: finish.reason },
      "An update from Settings finished",
    );
    if (finish.result === "succeeded") {
      notify(row.accountId, { kind: "update-succeeded", version: row.toVersion, at: nowIso() });
    } else if (finish.result === "rolled-back" || finish.result === "rollback-failed") {
      const reason = finish.reason === null ? "no reason given" : (REASON_WORDS[finish.reason] ?? finish.reason);
      notify(row.accountId, { kind: "update-rolled-back", result: finish.result, from: row.fromVersion, to: row.toVersion, reason });
    }
  };

  /** The server's own end of a request, kept in the database, then recorded. */
  const finishOnServer = (row: UpdateRequestRow, reason: UpdateReason, signingKey: string | null = null): void => {
    repository.finishOnServer(row.requestId, "refused", reason, nowIso());
    recordFinish(row, { result: "refused", reason, signingKey });
  };

  const recordStatus = (row: UpdateRequestRow, status: UpdateStatusFile): void => {
    if (status.result !== null) recordFinish(row, { result: status.result, reason: status.reason, signingKey: status.signingKey });
  };

  const recordFinishedWith = async (read: StatusFileRead): Promise<void> => {
    // Asked once per call, and only for a request that may have stopped with its server.
    let verifyEnded: Promise<StatusFileRead | undefined> | undefined;
    for (const row of repository.unrecordedRequests()) {
      if (active?.requestId === row.requestId) continue;
      if (row.result !== null) {
        recordFinish(row, { result: "refused", reason: storedReason(row.reason), signingKey: null });
        continue;
      }
      const status = statusOf(row, read);
      if (status !== undefined) {
        recordStatus(row, status);
        continue;
      }
      if (row.handedOverAt !== null) continue;
      // Never handed over and not downloading here: the server stopped while it downloaded, or while
      // the verify unit ran, which goes on without it. Once that unit is done, its status file, read
      // again, says whether it took the request; without one, the request never reached it.
      verifyEnded ??= helper.isRunning().then(async (verifying) => (verifying ? undefined : readStatusFile(paths.statusFile)));
      const ended = await verifyEnded;
      if (ended === undefined) continue;
      const after = statusOf(row, ended);
      if (after === undefined) finishOnServer(row, "download-failed");
      else recordStatus(row, after);
    }
  };

  const updateOf = (read: StatusFileRead): Update | null => {
    if (active !== undefined) {
      const status = statusOf(active, read);
      if (status !== undefined) return fromStatus(active, status);
      return { ...active, phase: "downloading", result: null, reason: null, finishedAt: null };
    }
    const row = repository.latestRequest();
    if (row === undefined) return null;
    const base = { requestId: row.requestId, from: row.fromVersion, to: row.toVersion, startedAt: row.startedAt };
    if (row.result !== null) {
      return {
        ...base,
        phase: "finished",
        result: "refused",
        reason: storedReason(row.reason),
        finishedAt: row.finishedAt,
      };
    }
    const status = statusOf(row, read);
    if (status !== undefined) return fromStatus(base, status);
    // The status file is gone or can't be trusted, or the verify unit hasn't written it yet (its server
    // stopped while it ran): the last phase the server knows.
    return { ...base, phase: row.handedOverAt === null ? "verifying" : "verified", result: null, reason: null, finishedAt: null };
  };

  const overview = async (): Promise<UpdatesOverview> => {
    const read = await readStatusFile(paths.statusFile);
    await recordFinishedWith(read);
    return {
      current: { version: runningVersion },
      check: checkOverview(),
      install: { enabled: installEnabled, switchCommand: UPDATE_FROM_UI_ON_COMMAND, installerCommand: INSTALLER_COMMAND },
      update: updateOf(read),
    };
  };

  // --- Installing --------------------------------------------------------------------------------

  const installTimes = new Map<string, number[]>();
  const countInstall = (accountId: string): void => {
    const now = nowMs();
    const times = installTimes.get(accountId) ?? [];
    installTimes.set(accountId, times);
    const retry = retryAt(times, INSTALL_LIMIT.max, INSTALL_LIMIT.windowMs, now);
    if (retry !== undefined) throw new Refused("denied", rateLimited(retry, now, "Too many tries to install an update. Try again later."));
    times.push(now);
  };

  const proveBothFactors = async (caller: Caller, reauthentication: Reauthentication, origin: UpdateOrigin): Promise<void> => {
    try {
      await reauthenticate(caller, reauthentication, origin);
    } catch (error) {
      // A wrong password or code, or too many tries: the sign-in module recorded its own event.
      if (error instanceof HttpProblem && (error.status === 401 || error.status === 429)) throw new Refused("denied", error);
      throw error;
    }
  };

  const assertInstallable = (version: string): void => {
    const latest = checkEnabled ? latestRelease() : undefined;
    if (latest === undefined || latest.version !== version || notInstallableBecause(latest, runningVersion, arch) !== null) {
      throw new Refused(
        "refused",
        new HttpProblem(
          409,
          problemTypes.updateNotAvailable,
          "Only the latest release, once it is installable, can be installed from Settings.",
        ),
      );
    }
  };

  const assertNoneRunning = (read: StatusFileRead): void => {
    if (active !== undefined || (read.kind === "known" && read.status.phase !== "finished")) {
      throw new Refused("refused", new HttpProblem(409, problemTypes.updateInProgress, "An update is in progress."));
    }
  };

  /** Downloads the three files into the emptied spool; answers the tarball's SHA-256. */
  const download = async (version: string, releaseArch: ReleaseArchitecture): Promise<string> => {
    await emptySpool(paths.spoolDir);
    const files = [
      { name: CHECKSUMS_FILE, cap: MAX_CHECKSUMS_FILE_BYTES },
      { name: SIGNATURE_FILE, cap: MAX_SIGNATURE_FILE_BYTES },
      { name: tarballName(version, releaseArch), cap: MAX_TARBALL_BYTES },
    ];
    let digest = "";
    for (const { name, cap } of files) {
      const body = await openDownload(fetch, version, name, cap);
      await writeSpoolFile(paths.spoolDir, name, body.chunks);
      digest = body.digest();
    }
    return digest;
  };

  /** The helper's own checks, only to fail early with a clear reason: the helper trusts none of this. */
  const verifyEarly = async (version: string, releaseArch: ReleaseArchitecture, tarballDigest: string): Promise<string> => {
    let keys;
    try {
      keys = await readTrustedKeys(paths.trustedKeysDir);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "The running release's pinned keys can't be read");
      throw new UpdateFailure("internal");
    }
    const checksums = await readSpoolFile(paths.spoolDir, CHECKSUMS_FILE);
    const signingKey = verifyChecksumsSignature(checksums, await readSpoolFile(paths.spoolDir, SIGNATURE_FILE), keys);
    checkChecksum(parseChecksums(checksums), tarballName(version, releaseArch), tarballDigest);
    return signingKey;
  };

  /** Hands the spool to the verify unit; answers how it ended. */
  const handOver = async (row: UpdateRequestRow): Promise<void> => {
    await writeUpdateRequest(paths.requestsDir, row.requestId, row.toVersion);
    try {
      const outcome = await helper.verify();
      if (outcome.ok) {
        repository.markHandedOver(row.requestId, nowIso());
        logger.info({ from: row.fromVersion, to: row.toVersion }, "The update helper verified the release and is installing it");
        return;
      }
      // A refusal after the helper read the request is in the status file, with the key that verified it.
      const status = statusOf(row, await readStatusFile(paths.statusFile));
      if (status?.result === "refused" && status.reason !== null) throw new UpdateFailure(status.reason, status.signingKey);
      throw new UpdateFailure(outcome.reason);
    } finally {
      // The next request deletes a stale one first, so a failed delete doesn't change the outcome.
      await deleteUpdateRequest(paths.requestsDir).catch((error: unknown) => {
        logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "The update helper's request couldn't be deleted");
      });
    }
  };

  const runUpdate = async (row: UpdateRequestRow): Promise<void> => {
    try {
      if (arch === undefined) throw new UpdateFailure("internal");
      const digest = await download(row.toVersion, arch);
      await verifyEarly(row.toVersion, arch, digest);
      await handOver(row);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.reason === "internal" && !(error instanceof UpdateFailure)) {
        logger.error({ err: error instanceof Error ? error.message : "unknown", to: row.toVersion }, "The update failed");
      } else {
        logger.warn({ to: row.toVersion, reason: failure.reason }, "The update was refused");
      }
      finishOnServer(row, failure.reason, failure.signingKey);
    } finally {
      // The helper has its own copies by now; nothing else reads the spool.
      await emptySpool(paths.spoolDir).catch((error: unknown) => {
        logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "The update spool couldn't be emptied");
      });
      active = undefined;
    }
  };

  const recordRequested = (
    caller: Caller,
    origin: UpdateOrigin,
    outcome: "accepted" | "denied" | "refused" | "error",
    requestId: string,
    to: string,
  ): void => {
    audit.record({
      action: "update.requested",
      actor: actorOf(caller),
      outcome: outcome === "accepted" ? "succeeded" : outcome === "error" ? "failed" : "denied",
      origin,
      details: { requestId, from: runningVersion, to, outcome },
    });
  };

  return {
    checkEnabled,
    installEnabled,
    overview,

    async checkNow() {
      if (!checkEnabled) throw new HttpProblem(404, problemTypes.notFound);
      countCheckNow();
      await askGitHub();
      return overview();
    },

    async checkIfDue() {
      if (!checkEnabled || nowMs() < nextCheckAt) return;
      await askGitHub();
    },

    async recordFinished() {
      await recordFinishedWith(await readStatusFile(paths.statusFile));
    },

    async install(caller, version, reauthentication, origin) {
      if (!installEnabled) throw new HttpProblem(404, problemTypes.notFound);
      const requestId = newId(clock);
      try {
        countInstall(caller.accountId);
        await proveBothFactors(caller, reauthentication, origin);
        assertInstallable(version);
        const read = await readStatusFile(paths.statusFile);
        await recordFinishedWith(read);
        // No await from here until `active` is set: two requests can't both pass.
        assertNoneRunning(read);
      } catch (error) {
        // Every request is recorded, one that ends in an unexpected error too.
        if (!(error instanceof Refused)) {
          recordRequested(caller, origin, "error", requestId, version);
          throw error;
        }
        recordRequested(caller, origin, error.outcome, requestId, version);
        throw error.problem;
      }
      const row: UpdateRequestRow = {
        requestId,
        accountId: caller.accountId,
        username: caller.username,
        fromVersion: runningVersion,
        toVersion: version,
        startedAt: nowIso(),
        handedOverAt: null,
        result: null,
        reason: null,
        finishedAt: null,
        recordedAt: null,
      };
      active = { requestId, from: row.fromVersion, to: row.toVersion, startedAt: row.startedAt };
      repository.insertRequest(row);
      recordRequested(caller, origin, "accepted", requestId, version);
      logger.info({ from: row.fromVersion, to: row.toVersion }, "An update from Settings was requested");
      running = runUpdate(row);
      return { requestId };
    },

    settled: () => running,
  };
}

/** A refusal of the server's own, or the helper's: `refused` and its reason. */
class UpdateFailure extends Error {
  override readonly name = "UpdateFailure";
  readonly reason: UpdateReason;
  readonly signingKey: string | null;

  constructor(reason: UpdateReason, signingKey: string | null = null) {
    super(reason);
    this.reason = reason;
    this.signingKey = signingKey;
  }
}

function failureOf(error: unknown): { readonly reason: UpdateReason; readonly signingKey: string | null } {
  if (error instanceof UpdateFailure) return { reason: error.reason, signingKey: error.signingKey };
  if (error instanceof DownloadError) return { reason: error.reason, signingKey: null };
  if (error instanceof ReleaseVerifyError) return { reason: error.problem, signingKey: null };
  return { reason: "internal", signingKey: null };
}
