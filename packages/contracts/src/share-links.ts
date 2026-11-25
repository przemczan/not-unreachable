import { z } from "zod";
import { entriesPageSchema, entriesQuerySchema, entryPathSchema, entryTargetPathSchema } from "./files.ts";
import { defineRoute } from "./route.ts";

/*
 * Share links (domain.md, Glossary; threat model, T8). Only the admin makes and manages them; anyone
 * holding a link's token reaches the public share API, which never says which resource or path the
 * link points into, only the shared item's own name. A link's access can narrow that to signed-in
 * accounts or to users the admin picks.
 */

export const shareLinkKinds = ["file", "folder"] as const;
export type ShareLinkKind = (typeof shareLinkKinds)[number];

/** The Share links screen's filters. A link is locked while it is active, so Locked is a flag, not a state. */
export const shareLinkStates = ["active", "expired", "revoked"] as const;
export type ShareLinkState = (typeof shareLinkStates)[number];

/**
 * A link's link access (domain.md, Glossary): who can open it. Anyone holding the link; any signed-in
 * account; or only the users the admin picked, and the admin. The link password is a separate switch.
 */
export const shareLinkAccesses = ["anyone", "signed-in", "selected-users"] as const;
export type ShareLinkAccess = (typeof shareLinkAccesses)[number];

/** A link with "Selected users" lists at most this many users. */
export const SHARE_LINK_ALLOWED_USERS_MAX = 200;

/** A user a "Selected users" link was shared with. */
export const shareLinkAllowedUserSchema = z.strictObject({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
});
export type ShareLinkAllowedUser = z.infer<typeof shareLinkAllowedUserSchema>;

/** A new link expires after this many days unless the admin picks another time, or "No expiry" on purpose. */
export const DEFAULT_SHARE_LINK_EXPIRY_DAYS = 7;

export const SHARE_LINK_PASSWORD_MIN_LENGTH = 8;
export const SHARE_LINK_PASSWORD_MAX_LENGTH = 256;
export const SHARE_LINKS_PAGE_LIMIT_MAX = 200;

/** A link password, as the admin sets it and the holder types it. */
export const shareLinkPasswordSchema = z.string().min(SHARE_LINK_PASSWORD_MIN_LENGTH).max(SHARE_LINK_PASSWORD_MAX_LENGTH);

/**
 * A share-link token in a URL: 256 random bits, base64url (43 characters). Loose on purpose: a
 * malformed token gets the same `share-link-invalid` answer as an unknown one, never a validation
 * problem. The cap is Fastify's default `maxParamLength`: a longer path parameter gets its 414 before
 * any route runs, which tells nothing either, as no token is that long.
 */
export const shareLinkTokenSchema = z.string().min(1).max(100);

/** The public share page's path for a token. */
export const shareLinkPath = (token: string): string => `/s/${encodeURIComponent(token)}`;

/** A link as the admin's Share links screen lists it; never its token or its password. */
export const shareLinkSchema = z.strictObject({
  id: z.uuid(),
  resourceId: z.uuid(),
  resourceName: z.string(),
  /** Inside the resource, with `/` between segments. */
  path: z.string(),
  /** The shared item's own name: the last segment of `path`. */
  name: z.string(),
  kind: z.enum(shareLinkKinds),
  state: z.enum(shareLinkStates),
  hasPassword: z.boolean(),
  access: z.enum(shareLinkAccesses),
  /** Ordered by username; empty unless `access` is "selected-users" (and then empty only once every listed user was removed). */
  allowedUsers: z.array(shareLinkAllowedUserSchema),
  /** Null for a link made with "No expiry". */
  expiresAt: z.iso.datetime().nullable(),
  noExpiry: z.boolean(),
  /** Locked for an hour after too many wrong passwords (T8); null once that hour is over. */
  lockedUntil: z.iso.datetime().nullable(),
  locked: z.boolean(),
  downloadCount: z.int().min(0),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ShareLink = z.infer<typeof shareLinkSchema>;

/** A link with its whole URL, built from `PUBLIC_ORIGIN` and the token's envelope copy, for the admin to copy. */
export const shareLinkDetailSchema = z.strictObject({
  shareLink: shareLinkSchema,
  link: z.url(),
});
export type ShareLinkDetail = z.infer<typeof shareLinkDetailSchema>;

export const shareLinksQuerySchema = z.strictObject({
  state: z.enum(shareLinkStates).optional(),
  /** Opaque; from the previous page's `nextCursor`. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(SHARE_LINKS_PAGE_LIMIT_MAX).default(50),
});
export type ShareLinksQuery = z.input<typeof shareLinksQuerySchema>;

export const shareLinksPageSchema = z.strictObject({
  /** Newest first. */
  shareLinks: z.array(shareLinkSchema),
  nextCursor: z.string().nullable(),
});
export type ShareLinksPage = z.infer<typeof shareLinksPageSchema>;

/**
 * A link on a user's Shared with me (domain.md, Glossary; threat model, T8): one they can open. Only
 * what its share page shows them anyway, never the resource, the path or the allowed users.
 */
export const sharedWithMeLinkSchema = z.strictObject({
  id: z.uuid(),
  /** The shared item's own name. */
  name: z.string(),
  kind: z.enum(shareLinkKinds),
  /** Null for a link made with "No expiry". */
  expiresAt: z.iso.datetime().nullable(),
  hasPassword: z.boolean(),
  /** The link's whole URL, its normal share page. */
  link: z.url(),
});
export type SharedWithMeLink = z.infer<typeof sharedWithMeLinkSchema>;

export const sharedWithMeQuerySchema = z.strictObject({
  /** Opaque; from the previous page's `nextCursor`. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(SHARE_LINKS_PAGE_LIMIT_MAX).default(50),
});
export type SharedWithMeQuery = z.input<typeof sharedWithMeQuerySchema>;

export const sharedWithMePageSchema = z.strictObject({
  /** Newest first. */
  shareLinks: z.array(sharedWithMeLinkSchema),
  nextCursor: z.string().nullable(),
});
export type SharedWithMePage = z.infer<typeof sharedWithMePageSchema>;

/**
 * An expiry: a time (in the future, checked by the server), or "No expiry", which has to be picked on
 * purpose. Neither, on create, takes the 7-day default.
 */
const expiryFields = {
  expiresAt: z.iso.datetime().optional(),
  noExpiry: z.literal(true).optional(),
};

const oneExpiry = (value: { readonly expiresAt?: string | undefined; readonly noExpiry?: true | undefined }): boolean =>
  value.expiresAt === undefined || value.noExpiry === undefined;
const oneExpiryIssue = { message: "Choose either an expiry time or no expiry.", path: ["noExpiry"] };

/**
 * The link access, with the users picked for "Selected users": the list comes with that access, and
 * only with it. Each id must be a user's (role `user`), checked by the server (422 otherwise).
 */
const accessFields = {
  allowedUserIds: z.array(z.uuid()).min(1).max(SHARE_LINK_ALLOWED_USERS_MAX).optional(),
};

const usersOnlyWithSelectedUsers = (value: {
  readonly access?: ShareLinkAccess | undefined;
  readonly allowedUserIds?: readonly string[] | undefined;
}): boolean => (value.access === "selected-users") === (value.allowedUserIds !== undefined);
const usersOnlyWithSelectedUsersIssue = { message: 'Pick the users for "Selected users", and only for it.', path: ["allowedUserIds"] };

export const createShareLinkRequestSchema = z
  .strictObject({
    resourceId: z.uuid(),
    /** The file or folder to share; never the resource's top folder. */
    path: entryTargetPathSchema,
    password: shareLinkPasswordSchema.optional(),
    access: z.enum(shareLinkAccesses).default("anyone"),
    ...accessFields,
    ...expiryFields,
  })
  .refine(oneExpiry, oneExpiryIssue)
  .refine(usersOnlyWithSelectedUsers, usersOnlyWithSelectedUsersIssue);
export type CreateShareLinkRequest = z.input<typeof createShareLinkRequestSchema>;

/**
 * What to change: the expiry, the password, the link access, or any of them. A password of null
 * removes it; any change of the password deletes every unlock. A change to "Selected users" gives the
 * whole new list, which replaces the old one.
 */
export const changeShareLinkRequestSchema = z
  .strictObject({
    ...expiryFields,
    password: shareLinkPasswordSchema.nullable().optional(),
    access: z.enum(shareLinkAccesses).optional(),
    ...accessFields,
  })
  .refine(oneExpiry, oneExpiryIssue)
  .refine(usersOnlyWithSelectedUsers, usersOnlyWithSelectedUsersIssue)
  .refine(
    (value) => value.expiresAt !== undefined || value.noExpiry !== undefined || value.password !== undefined || value.access !== undefined,
    { message: "Change the expiry, the password or who can open the link." },
  );
export type ChangeShareLinkRequest = z.input<typeof changeShareLinkRequestSchema>;

/** What the public share page shows: the item's own name, its size and the expiry; never the resource or the path. */
export const publicShareLinkSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(shareLinkKinds),
  /** Bytes, for a file; null for a folder. */
  size: z.int().min(0).nullable(),
  expiresAt: z.iso.datetime().nullable(),
  /** The link has a password and this browser hasn't unlocked it yet. */
  passwordRequired: z.boolean(),
});
export type PublicShareLink = z.infer<typeof publicShareLinkSchema>;

export const unlockShareLinkRequestSchema = z.strictObject({ password: z.string().min(1).max(SHARE_LINK_PASSWORD_MAX_LENGTH) });
export type UnlockShareLinkRequest = z.infer<typeof unlockShareLinkRequestSchema>;

/** A path inside a folder link, relative to the shared folder; empty (or left out) for a file link's own file. */
export const shareContentQuerySchema = z.strictObject({ path: entryPathSchema.default("") });
export type ShareContentQuery = z.input<typeof shareContentQuerySchema>;

const shareLinkParams = z.strictObject({ id: z.uuid() });
const tokenParams = z.strictObject({ token: shareLinkTokenSchema });

/* The admin's Share links. */

/** The kind is read from the item itself; 404 for a missing one, 422 `path-refused` for a link or a special file. */
export const createShareLinkRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/share-links",
  access: "admin",
  recentSignIn: false,
  safe: false,
  body: createShareLinkRequestSchema,
  responses: { 201: shareLinkDetailSchema },
});

export const listShareLinksRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/share-links",
  access: "admin",
  recentSignIn: false,
  safe: true,
  query: shareLinksQuerySchema,
  responses: { 200: shareLinksPageSchema },
});

export const getShareLinkRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/share-links/:id",
  access: "admin",
  recentSignIn: false,
  safe: true,
  params: shareLinkParams,
  responses: { 200: shareLinkDetailSchema },
});

/** 409 `share-link-revoked` for a revoked link, which can't change any more. */
export const changeShareLinkRoute = defineRoute({
  method: "PATCH",
  path: "/api/v1/admin/share-links/:id",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: shareLinkParams,
  body: changeShareLinkRequestSchema,
  responses: { 200: shareLinkDetailSchema },
});

/** Takes effect on the next request, a download's next range request included. Revoking twice is a no-op. */
export const revokeShareLinkRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/share-links/:id/revoke",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: shareLinkParams,
  responses: { 200: shareLinkSchema },
});

/* A user's Shared with me. */

/**
 * The active links the signed-in user can open: every "Signed-in users" link, and every "Selected
 * users" link that lists them. Never an "Anyone with the link" one; a locked link still shows.
 */
export const listSharedWithMeRoute = defineRoute({
  method: "GET",
  path: "/api/v1/share-links/shared-with-me",
  access: "user",
  recentSignIn: false,
  safe: true,
  query: sharedWithMeQuerySchema,
  responses: { 200: sharedWithMePageSchema },
});

/*
 * The public share API (threat model, T8, T11). An unknown, malformed, expired or revoked token, and
 * one whose item is gone, all get the same 404 `share-link-invalid`, byte for byte. Then the link
 * access, on every route: a "Signed-in users" or "Selected users" link needs an active session (401
 * `share-link-sign-in-required`), and a "Selected users" one the admin's or a listed user's (403
 * `share-link-not-allowed`); neither tells anything about the item. Then a link with a password needs
 * an unlock cookie for its entries and content (401 `share-link-password-required`).
 */

export const getPublicShareLinkRoute = defineRoute({
  method: "GET",
  path: "/api/v1/public/share-links/:token",
  access: "public",
  recentSignIn: false,
  safe: true,
  params: tokenParams,
  responses: { 200: publicShareLinkSchema },
});

/**
 * Sets `__Host-nu_unlock_<linkId>` for 12 hours, or until the link expires. 401
 * `share-link-password-wrong`; 429 `too-many-attempts` with `Retry-After` while the link is locked.
 */
export const unlockShareLinkRoute = defineRoute({
  method: "POST",
  path: "/api/v1/public/share-links/:token/unlock",
  access: "public",
  recentSignIn: false,
  safe: false,
  params: tokenParams,
  body: unlockShareLinkRequestSchema,
  responses: { 204: z.undefined() },
});

/** A folder link only (404 `share-link-invalid` for a file link); the path is relative to the shared folder. */
export const listShareLinkEntriesRoute = defineRoute({
  method: "GET",
  path: "/api/v1/public/share-links/:token/entries",
  access: "public",
  recentSignIn: false,
  safe: true,
  params: tokenParams,
  query: entriesQuerySchema,
  responses: { 200: entriesPageSchema },
});

/**
 * A download, whole (200) or one byte range (206), as the admin's downloads are. A file link serves
 * only its own file (an empty path); 429 `too-many-downloads` past 4 at once per IP.
 */
export const downloadShareLinkContentRoute = defineRoute({
  method: "GET",
  path: "/api/v1/public/share-links/:token/content",
  access: "public",
  recentSignIn: false,
  safe: true,
  params: tokenParams,
  query: shareContentQuerySchema,
  responses: { 200: z.string(), 206: z.string() },
});

/** The routes a share link's token reaches, which the share limits and headers apply to. */
export const publicShareLinkRoutes = [
  getPublicShareLinkRoute,
  unlockShareLinkRoute,
  listShareLinkEntriesRoute,
  downloadShareLinkContentRoute,
] as const;
