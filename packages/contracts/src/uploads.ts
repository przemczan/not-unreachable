import { z } from "zod";
import { entryNameSchema, entryPathSchema } from "./files.ts";
import { defineRoute } from "./route.ts";

/*
 * Resumable uploads over tus 1.0.0 (stack.md, "Resumable uploads: tus"; threat model, T7). The
 * creation's `Upload-Length` is required (no deferred length) and its `Upload-Metadata` carries the
 * target below; everything is checked at creation, before any byte is stored, and again when the
 * last chunk arrives. Only the account that created an upload can continue or cancel it.
 */

/** The size of each chunk the client sends. */
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
/** The most bytes one `PATCH` may carry. */
export const UPLOAD_PATCH_MAX_BYTES = 64 * 1024 * 1024;
/** The media type of a tus chunk. */
export const UPLOAD_CHUNK_MEDIA_TYPE = "application/offset+octet-stream";
/** The tus protocol version, sent as `Tus-Resumable`. */
export const TUS_VERSION = "1.0.0";

/**
 * What happens when the name is taken in the target folder: refuse with 409 `name-taken` (the
 * default, so the client asks Replace or Keep both), replace the file, or keep both (`name (1).ext`).
 */
export const uploadConflictChoices = ["fail", "replace", "keep-both"] as const;
export type UploadConflictChoice = (typeof uploadConflictChoices)[number];

/** A user's upload: always into their own home, so it names no resource. */
export const homeUploadMetadataSchema = z.strictObject({
  /** The folder in the home, "" for its top folder. */
  folder: entryPathSchema.default(""),
  name: entryNameSchema,
  onConflict: z.enum(uploadConflictChoices).default("fail"),
});
export type HomeUploadMetadata = z.input<typeof homeUploadMetadataSchema>;

/** The admin's upload: into any available resource. */
export const resourceUploadMetadataSchema = homeUploadMetadataSchema.extend({ resourceId: z.uuid() });
export type ResourceUploadMetadata = z.input<typeof resourceUploadMetadataSchema>;

/** Why an upload can't start now (429 `too-many-uploads`). */
export const tooManyUploadsReasons = ["in-progress-per-account", "in-progress-per-instance", "created-per-hour"] as const;
export type TooManyUploadsReason = (typeof tooManyUploadsReasons)[number];

const uploadParamsSchema = z.strictObject({ id: z.uuid() });

/** tus creation; answers 201 with `Location: /api/v1/uploads/<id>`. */
export const createUploadRoute = defineRoute({
  method: "POST",
  path: "/api/v1/uploads",
  access: "account",
  recentSignIn: false,
  safe: false,
  responses: { 201: z.undefined() },
});

/** tus offset: answers 200 with `Upload-Offset` and `Upload-Length`, no body. */
export const getUploadOffsetRoute = defineRoute({
  method: "HEAD",
  path: "/api/v1/uploads/:id",
  access: "account",
  recentSignIn: false,
  safe: true,
  params: uploadParamsSchema,
  responses: { 200: z.undefined() },
});

/** One chunk at `Upload-Offset`; the last one moves the file into place before the answer. */
export const sendUploadChunkRoute = defineRoute({
  method: "PATCH",
  path: "/api/v1/uploads/:id",
  access: "account",
  recentSignIn: false,
  safe: false,
  params: uploadParamsSchema,
  rawBody: { mediaType: UPLOAD_CHUNK_MEDIA_TYPE, maxBytes: UPLOAD_PATCH_MAX_BYTES },
  responses: { 204: z.undefined() },
});

/** tus termination: cancels an unfinished upload and deletes what was staged. */
export const cancelUploadRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/uploads/:id",
  access: "account",
  recentSignIn: false,
  safe: false,
  params: uploadParamsSchema,
  responses: { 204: z.undefined() },
});
