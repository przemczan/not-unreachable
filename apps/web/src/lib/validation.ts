import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, problemTypes } from "@not-unreachable/contracts";
import { ApiError } from "../api/index.ts";

export const newPasswordHint = `${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`;

export const breachedPasswordMessage = "This password is on a list of leaked passwords. Choose another one.";

/** The errors of a new password and its confirmation: none when both are fine. */
export function newPasswordErrors(password: string, confirmation: string): { password?: string; confirmation?: string } {
  if (password.length < PASSWORD_MIN_LENGTH) return { password: `Use at least ${PASSWORD_MIN_LENGTH} characters.` };
  if (password.length > PASSWORD_MAX_LENGTH) return { password: `Use at most ${PASSWORD_MAX_LENGTH} characters.` };
  if (password !== confirmation) return { confirmation: "The passwords don't match." };
  return {};
}

/** A control's `error` prop: left out without a message, as optional props never take `undefined`. */
export function errorProp(message: string | undefined): { error?: string } {
  return message === undefined ? {} : { error: message };
}

/** True when the error is a problem answer of this type. */
export function isProblem(error: unknown, type: string): error is ApiError {
  return error instanceof ApiError && error.type === type;
}

/** The words for the problems of files and uploads, whichever screen meets them. */
const fileProblemWording: Readonly<Partial<Record<string, string>>> = {
  [problemTypes.nameTaken]: "Something with this name is already in this folder.",
  [problemTypes.folderNotEmpty]: "This folder isn't empty. Delete it with everything in it, or empty it first.",
  [problemTypes.rangeNotSatisfiable]: "That part of the file can't be sent. Download the file again from the start.",
  [problemTypes.quotaExceeded]: "There isn't enough room left in your storage for this file. Delete some files and try again.",
  [problemTypes.fileTooLarge]: "This file is larger than the largest upload allowed.",
  [problemTypes.uploadLengthRequired]: "The browser didn't say how large the file is. Try again in another browser.",
  [problemTypes.insufficientStorage]: "The server is running out of space. Ask the admin to free some up.",
};

/** Why a new upload can't start now, by the reason of a `too-many-uploads` problem. */
const tooManyUploadsWording: Readonly<Partial<Record<string, string>>> = {
  "in-progress-per-account": "You have too many uploads in progress. Let one finish, or cancel one, then try again.",
  "in-progress-per-instance": "The server has too many uploads in progress. Try again in a few minutes.",
  "created-per-hour": "You started too many uploads in the last hour. Try again later.",
};

/**
 * A sentence for a failed request that a screen has no wording of its own for. The problem's own
 * detail is shown as text; it never holds internals (problem.ts).
 */
export function problemMessage(error: unknown, fallback = "That did not work. Try again."): string {
  if (!(error instanceof ApiError)) return fallback;
  const fileWording = fileProblemWording[error.type];
  if (fileWording !== undefined) return fileWording;
  if (error.type === problemTypes.tooManyUploads) {
    return tooManyUploadsWording[error.problem.reason ?? ""] ?? "There are too many uploads right now. Try again later.";
  }
  if (error.type === problemTypes.tooManyAttempts || error.type === problemTypes.rateLimited) {
    return "Too many attempts. Wait a few minutes and try again.";
  }
  if (error.type === problemTypes.serviceUnavailable) return "NotUnreachable is not available right now. Try again in a few minutes.";
  if (error.type === problemTypes.ssoProviderUnreachable) return "The provider could not be reached. Try again later.";
  if (error.status >= 500) return fallback;
  return error.problem.detail ?? error.problem.title;
}
