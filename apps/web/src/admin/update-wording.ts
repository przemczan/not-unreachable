import type { NotInstallableReason, Update, UpdateReason, UpdateResult } from "@not-unreachable/contracts";

/** The command that shows what an update did, on the server. */
export const UPDATE_JOURNAL_COMMAND = "journalctl -u not-unreachable-update-apply -u not-unreachable";

/** The command that finishes an update that stopped half-way. */
export const UPDATE_RECOVER_COMMAND = "sudo not-unreachable update-recover";

/** Every release, for a server that doesn't ask GitHub itself. */
export const ALL_RELEASES_URL = "https://github.com/przemczan/not-unreachable/releases";

/** An install request whose answer was lost, after which no update appeared: it never reached the server. */
export const REQUEST_LOST_WORDING = { title: "The install request didn't reach the server", text: "Nothing was changed. Try again." };

/**
 * The steps' words while the server goes back: the install may have failed or the new release not
 * started, so they say neither.
 */
export const rollingBackWording = {
  installed: (to: string) => `Tried ${to}`,
  wentWrong: (to: string) => `${to} didn't work properly`,
};

/**
 * What a result shows under its text: the one-line installer, the `update-from-ui on` command, the
 * `update-recover` command, the journal, or a note to report it.
 */
export type UpdateFollowUp = "installer" | "switch" | "recover" | "journal" | "report" | null;

export interface ResultWording {
  readonly text: string;
  readonly followUp: UpdateFollowUp;
}

type Versions = Pick<Update, "from" | "to">;

const wentBack = (from: string) => `so the server went back to ${from} with its data as before the update.`;

const somethingWentWrong: ResultWording = { text: "Something went wrong on the server. Nothing was changed.", followUp: "journal" };

const damagedArchive: ResultWording = {
  text: "The release archive is damaged or holds files it shouldn't. Nothing on the server was changed.",
  followUp: "report",
};

/** The hero's text for each reason (the design's "Wording of each reason"). */
const reasonWording: Record<UpdateReason, (versions: Versions) => ResultWording> = {
  "download-failed": () => ({
    text: "GitHub couldn't be reached, or the download stopped. Nothing on the server was changed. Try again later.",
    followUp: null,
  }),
  "download-incomplete": () => ({
    text: "The download was incomplete or too large. Nothing on the server was changed. Try again.",
    followUp: null,
  }),
  unsigned: () => ({
    text: "This release isn't signed with a key this server trusts, so it can't be installed from here. Install it over SSH.",
    followUp: "installer",
  }),
  "signature-invalid": () => ({
    text: "Its signature doesn't match NotUnreachable's release key, so the download may have been changed. Nothing on the server was changed.",
    followUp: "report",
  }),
  "checksum-mismatch": () => ({
    text: "The download doesn't match its signed checksum, so it may have been changed. Nothing on the server was changed.",
    followUp: "report",
  }),
  "version-mismatch": () => ({
    text: "The download isn't the version it claims to be. Nothing on the server was changed.",
    followUp: "report",
  }),
  "not-newer": ({ to }) => ({ text: `This server already runs ${to} or a newer release.`, followUp: null }),
  "archive-unsafe": () => damagedArchive,
  "archive-invalid": () => damagedArchive,
  "needs-installer": () => ({
    text: "This release needs changes only the installer can make, such as a newer Node.js. Install it over SSH.",
    followUp: "installer",
  }),
  "no-space": () => ({ text: "There isn't enough free disk space on the server. Free some space and try again.", followUp: null }),
  "switch-off": () => ({ text: "Installing from here was turned off on the server.", followUp: "switch" }),
  busy: () => ({ text: "Another update is running. Wait for it to finish.", followUp: null }),
  interrupted: () => ({ text: "An earlier update stopped half-way.", followUp: "recover" }),
  "installer-failed": ({ from, to }) => ({ text: `Installing ${to} failed, ${wentBack(from)}`, followUp: "journal" }),
  "start-failed": ({ from, to }) => ({ text: `${to} didn't start within 5 minutes, ${wentBack(from)}`, followUp: "journal" }),
  unhealthy: ({ from, to }) => ({ text: `${to} didn't keep running after it started, ${wentBack(from)}`, followUp: "journal" }),
  "request-invalid": () => somethingWentWrong,
  "systemd-failed": () => somethingWentWrong,
  internal: () => somethingWentWrong,
};

/**
 * The reasons a refused update may work on another try, which its result then offers. The others
 * won't change by trying again: a release that doesn't check out, or one that needs the server.
 */
const transientReasons: ReadonlySet<UpdateReason> = new Set<UpdateReason>([
  "download-failed",
  "download-incomplete",
  "no-space",
  "busy",
  "internal",
  "systemd-failed",
  "request-invalid",
]);

export type FailedResult = Exclude<UpdateResult, "succeeded">;

/** Whether an update that didn't succeed may work if installed again: after a rollback, or a refusal that may pass. */
export function canTryAgain(update: Update & { readonly result: FailedResult }): boolean {
  if (update.result === "rolled-back") return true;
  return update.result === "refused" && (update.reason === null || transientReasons.has(update.reason));
}

/** The hero's title for an update that didn't succeed. */
const resultTitles: Record<FailedResult, (to: string) => string> = {
  refused: (to) => `${to} wasn't installed`,
  "rolled-back": (to) => `The update to ${to} was rolled back`,
  interrupted: (to) => `The update to ${to} stopped half-way`,
  "rollback-failed": (to) => `The update to ${to} failed and couldn't be rolled back`,
};

export function resultTitle(result: FailedResult, to: string): string {
  return resultTitles[result](to);
}

/** The hero's text and what follows it, for an update that didn't succeed. */
export function resultWording(update: Update & { readonly result: FailedResult }): ResultWording {
  const { from, to } = update;
  if (update.result === "interrupted") {
    return {
      text: `The server stopped during the update, for example in a power cut. Run this on the server to go back to ${from}; you can update again afterwards.`,
      followUp: "recover",
    };
  }
  if (update.result === "rollback-failed") {
    return {
      text: `${to} didn't work, and going back to ${from} didn't work either, so the server had to be repaired on it.`,
      followUp: "journal",
    };
  }
  const wording = update.reason === null ? somethingWentWrong : reasonWording[update.reason](update);
  // A rollback always shows where to see what happened.
  return update.result === "rolled-back" ? { ...wording, followUp: "journal" } : wording;
}

/** The Last update row's badge. */
export const resultBadge: Record<UpdateResult, string> = {
  succeeded: "Updated",
  refused: "Not installed",
  "rolled-back": "Rolled back",
  "rollback-failed": "Couldn't roll back",
  interrupted: "Stopped half-way",
};

/** Why the latest release can't be installed from here. */
export const notInstallableWording: Record<Exclude<NotInstallableReason, "not-newer">, string> = {
  unsigned:
    "This release isn't signed, so it can't be installed from here. Install it over SSH once; later releases can then be installed from here.",
  "no-tarball": "This release has no download for this server, so it can't be installed from here. Install it over SSH.",
};
