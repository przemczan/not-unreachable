import type { TooManyUploadsReason } from "@not-unreachable/contracts";

// Messages never hold a path: they may reach logs and answers.

/** No such upload, or not the caller's, or expired: all answer 404 alike. */
export class UploadNotFoundError extends Error {
  override readonly name = "UploadNotFoundError";

  constructor() {
    super("No such upload");
  }
}

/** The creation's `Upload-Metadata` doesn't match the caller's schema (a user's names no resource). */
export class UploadMetadataError extends Error {
  override readonly name = "UploadMetadataError";
}

export class FileTooLargeError extends Error {
  override readonly name = "FileTooLargeError";

  constructor() {
    super("The file is larger than the size limit");
  }
}

export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";

  constructor() {
    super("The upload doesn't fit in the quota");
  }
}

/** Completing the upload would leave less than the disk reserve free on the staging disk or the target. */
export class InsufficientStorageError extends Error {
  override readonly name = "InsufficientStorageError";

  constructor() {
    super("There isn't enough free disk space");
  }
}

export class TooManyUploadsError extends Error {
  override readonly name = "TooManyUploadsError";
  readonly reason: TooManyUploadsReason;
  /** For `created-per-hour`: when the oldest creation of the hour leaves the window. */
  readonly retryAfterSeconds: number | undefined;

  constructor(reason: TooManyUploadsReason, retryAfterSeconds?: number) {
    super(`Too many uploads (${reason})`);
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A folder holds entries and the delete wasn't recursive. */
export class FolderNotEmptyError extends Error {
  override readonly name = "FolderNotEmptyError";

  constructor() {
    super("The folder is not empty");
  }
}

/** A listing cursor this server didn't make. */
export class InvalidEntriesCursorError extends Error {
  override readonly name = "InvalidEntriesCursorError";

  constructor() {
    super("The cursor is not valid");
  }
}
