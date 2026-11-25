import { problemTypes } from "@not-unreachable/contracts";
import { HttpProblem } from "../../http/index.ts";
import { HomeNotFoundError, ResourceNotFoundError, ResourceUnavailableError } from "../resources/index.ts";
import { NameRefusedError, NameTakenError, PathRefusedError } from "../storage/index.ts";
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

/**
 * The problem a refusal of the files module answers, or undefined for any other error (a 500). A
 * path that names nothing is a 404; every other path or name refusal a 422 with its reason.
 */
export function refusalProblem(error: unknown): HttpProblem | undefined {
  if (error instanceof HttpProblem) return error;
  if (error instanceof UploadNotFoundError || error instanceof ResourceNotFoundError) return new HttpProblem(404, problemTypes.notFound);
  if (error instanceof HomeNotFoundError) return new HttpProblem(404, problemTypes.notFound, "You have no home folder yet.");
  if (error instanceof ResourceUnavailableError) return new HttpProblem(409, problemTypes.resourceUnavailable);
  if (error instanceof PathRefusedError) {
    if (error.reason === "not-found") return new HttpProblem(404, problemTypes.notFound, undefined, {}, { reason: error.reason });
    return new HttpProblem(422, problemTypes.pathRefused, undefined, {}, { reason: error.reason });
  }
  if (error instanceof NameRefusedError) return new HttpProblem(422, problemTypes.pathRefused, undefined, {}, { reason: error.reason });
  if (error instanceof NameTakenError) return new HttpProblem(409, problemTypes.nameTaken);
  if (error instanceof FolderNotEmptyError)
    return new HttpProblem(409, problemTypes.folderNotEmpty, "Delete it with everything in it instead.");
  if (error instanceof QuotaExceededError) return new HttpProblem(413, problemTypes.quotaExceeded);
  if (error instanceof FileTooLargeError) return new HttpProblem(413, problemTypes.fileTooLarge);
  if (error instanceof InsufficientStorageError) return new HttpProblem(507, problemTypes.insufficientStorage);
  if (error instanceof TooManyUploadsError) {
    const headers: Record<string, string> = error.retryAfterSeconds === undefined ? {} : { "retry-after": String(error.retryAfterSeconds) };
    return new HttpProblem(429, problemTypes.tooManyUploads, undefined, headers, { reason: error.reason });
  }
  if (error instanceof UploadMetadataError) return new HttpProblem(400, problemTypes.validationFailed, error.message);
  if (error instanceof InvalidEntriesCursorError) return new HttpProblem(400, problemTypes.badRequest, "The cursor is not valid.");
  return undefined;
}

/** Runs `work`, turning the module's refusals into problems; anything else is rethrown (a 500). */
export async function mapped<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw refusalProblem(error) ?? error;
  }
}
