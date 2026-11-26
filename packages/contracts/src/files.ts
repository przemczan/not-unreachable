import { z } from "zod";
import { LOCAL_PATH_MAX_BYTES } from "./resources.ts";
import { defineRoute } from "./route.ts";

/*
 * Files (domain.md, "Files and uploads"). The admin reaches every available resource by its id; a
 * user reaches only their own home, and no user route takes a resource id (threat model, T5 step 8).
 * Every path is relative to the resource (or the home), with `/` between segments; the server
 * checks it as it checks every path (T5).
 */

/** How a listing shows an entry. A symlink is `link` ("link (not followed)") and is never followed. */
export const entryKinds = ["file", "folder", "link", "other"] as const;
export type EntryKind = (typeof entryKinds)[number];

export const ENTRIES_PAGE_LIMIT_MAX = 200;
/** The most bytes of one name (T5, step 1). */
export const ENTRY_NAME_MAX_BYTES = 255;

/** A path inside a resource or a home; empty for its top folder. */
export const entryPathSchema = z.string().max(LOCAL_PATH_MAX_BYTES);

/** A path that names an entry, never the top folder itself. */
export const entryTargetPathSchema = entryPathSchema.min(1);

/** A new entry's name; the server checks it by the T5 step 7 rules. */
export const entryNameSchema = z.string().min(1).max(ENTRY_NAME_MAX_BYTES);

export const entrySchema = z.strictObject({
  name: z.string(),
  kind: z.enum(entryKinds),
  /** Bytes, for a file; 0 otherwise. */
  size: z.int().min(0),
  modifiedAt: z.iso.datetime(),
});
export type Entry = z.infer<typeof entrySchema>;

/** What a listing can be sorted by: the entry's name, its size, or when it was last modified. */
export const entrySortKeys = ["name", "size", "modified"] as const;
export type EntrySortKey = (typeof entrySortKeys)[number];

export const sortOrders = ["asc", "desc"] as const;
export type SortOrder = (typeof sortOrders)[number];

export const entriesQuerySchema = z.strictObject({
  path: entryPathSchema.default(""),
  sort: z.enum(entrySortKeys).default("name"),
  order: z.enum(sortOrders).default("asc"),
  /** Opaque; from the previous page's `nextCursor`, listed with the same `sort` and `order`. */
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(ENTRIES_PAGE_LIMIT_MAX).default(ENTRIES_PAGE_LIMIT_MAX),
});
export type EntriesQuery = z.input<typeof entriesQuerySchema>;

export const entriesPageSchema = z.strictObject({
  /** The folder listed, as the server normalised it (NFC, no leading or trailing `/`). */
  path: z.string(),
  /**
   * Folders first, whatever the order, then the rest; each group by the query's `sort` in its
   * `order`, ties broken by name in the same order. Folders have size 0, so by size they go by name.
   */
  entries: z.array(entrySchema),
  nextCursor: z.string().nullable(),
});
export type EntriesPage = z.infer<typeof entriesPageSchema>;

export const newFolderRequestSchema = z.strictObject({
  /** The folder the new one goes into. */
  path: entryPathSchema.default(""),
  name: entryNameSchema,
});
export type NewFolderRequest = z.input<typeof newFolderRequestSchema>;

export const contentQuerySchema = z.strictObject({ path: entryTargetPathSchema });
export type ContentQuery = z.infer<typeof contentQuerySchema>;

export const deleteEntryQuerySchema = z.strictObject({
  path: entryTargetPathSchema,
  /** Needed to delete a folder, with everything in it; the UI confirms it first. */
  recursive: z.stringbool().default(false),
});
export type DeleteEntryQuery = z.input<typeof deleteEntryQuerySchema>;

/** A user's quota, as the QuotaMeter shows it. */
export const quotaSchema = z.strictObject({
  /** The bytes in the home plus the user's unfinished uploads. */
  usedBytes: z.int().min(0),
  limitBytes: z.int().min(0),
});
export type Quota = z.infer<typeof quotaSchema>;

const resourceParamsSchema = z.strictObject({ resourceId: z.uuid() });

/** A download: `application/octet-stream` as an attachment, whole (200) or one byte range (206). */
const contentResponses = { 200: z.string(), 206: z.string() } as const;

/* The admin: every available resource. */

export const listResourceEntriesRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/resources/:resourceId/entries",
  access: "admin",
  recentSignIn: false,
  safe: true,
  params: resourceParamsSchema,
  query: entriesQuerySchema,
  responses: { 200: entriesPageSchema },
});

export const createResourceFolderRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/resources/:resourceId/folders",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: resourceParamsSchema,
  body: newFolderRequestSchema,
  responses: { 201: entrySchema },
});

export const downloadResourceFileRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/resources/:resourceId/content",
  access: "admin",
  recentSignIn: false,
  safe: true,
  params: resourceParamsSchema,
  query: contentQuerySchema,
  responses: contentResponses,
});

/** The resource's top folder can't be deleted. */
export const deleteResourceEntryRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/admin/resources/:resourceId/entries",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: resourceParamsSchema,
  query: deleteEntryQuerySchema,
  responses: { 204: z.undefined() },
});

/* A user: their own home only, found on the server from the session. */

export const listHomeEntriesRoute = defineRoute({
  method: "GET",
  path: "/api/v1/home/entries",
  access: "user",
  recentSignIn: false,
  safe: true,
  query: entriesQuerySchema,
  responses: { 200: entriesPageSchema },
});

export const createHomeFolderRoute = defineRoute({
  method: "POST",
  path: "/api/v1/home/folders",
  access: "user",
  recentSignIn: false,
  safe: false,
  body: newFolderRequestSchema,
  responses: { 201: entrySchema },
});

export const downloadHomeFileRoute = defineRoute({
  method: "GET",
  path: "/api/v1/home/content",
  access: "user",
  recentSignIn: false,
  safe: true,
  query: contentQuerySchema,
  responses: contentResponses,
});

/** The home itself can't be deleted. */
export const deleteHomeEntryRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/home/entries",
  access: "user",
  recentSignIn: false,
  safe: false,
  query: deleteEntryQuerySchema,
  responses: { 204: z.undefined() },
});

export const getHomeQuotaRoute = defineRoute({
  method: "GET",
  path: "/api/v1/home/quota",
  access: "user",
  recentSignIn: false,
  safe: true,
  responses: { 200: quotaSchema },
});
