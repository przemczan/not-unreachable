import { z } from "zod";
import { defineRoute } from "./route.ts";
import { ssoProviderKinds } from "./sso.ts";

export const accountStatuses = ["active", "disabled"] as const;
export type AccountStatus = (typeof accountStatuses)[number];

/** A quota in bytes, as the admin sets it. */
export const quotaBytesSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** One of a user's linked sign-ins, as the admin's Users screen shows it. */
export const userLinkedSignInSchema = z.strictObject({
  id: z.uuid(),
  providerId: z.uuid(),
  providerName: z.string(),
  providerKind: z.enum(ssoProviderKinds),
  /** The email the provider reported when it was linked: for display only, never matched on. */
  email: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

export type UserLinkedSignIn = z.infer<typeof userLinkedSignInSchema>;

/** A user (role `user`) as the admin's Users screen shows them. The admin's own account isn't one. */
export const userSchema = z.strictObject({
  id: z.uuid(),
  username: z.string(),
  email: z.string().nullable(),
  displayName: z.string(),
  status: z.enum(accountStatuses),
  /** The user's own quota; null takes the default. */
  quotaBytes: quotaBytesSchema.nullable(),
  /** Oldest first. A user always has at least one, except for a moment while re-linking. */
  linkedSignIns: z.array(userLinkedSignInSchema),
  createdAt: z.iso.datetime(),
  disabledAt: z.iso.datetime().nullable(),
});

export type User = z.infer<typeof userSchema>;

export const usersSchema = z.strictObject({
  /** Oldest first. */
  users: z.array(userSchema),
  /** The quota of every user whose own is null. */
  defaultQuotaBytes: quotaBytesSchema,
});

export type Users = z.infer<typeof usersSchema>;

/** Disabling revokes the user's sessions and stops their sign-in. A null quota takes the default. */
export const changeUserRequestSchema = z
  .strictObject({
    status: z.enum(accountStatuses).optional(),
    quotaBytes: quotaBytesSchema.nullable().optional(),
  })
  .refine((change) => change.status !== undefined || change.quotaBytes !== undefined, "Change at least one field.");

export type ChangeUserRequest = z.input<typeof changeUserRequestSchema>;

/** What happens to a removed user's home: kept (the default), or deleted with everything in it. */
export const homeFolderChoices = ["keep", "delete"] as const;
export type HomeFolderChoice = (typeof homeFolderChoices)[number];

export const removeUserRequestSchema = z.strictObject({ homeFolder: z.enum(homeFolderChoices).default("keep") });

export type RemoveUserRequest = z.input<typeof removeUserRequestSchema>;

export const defaultQuotaSchema = z.strictObject({ defaultQuotaBytes: quotaBytesSchema });

export type DefaultQuota = z.infer<typeof defaultQuotaSchema>;

export const createdRelinkLinkSchema = z.strictObject({
  link: z.url(),
  expiresAt: z.iso.datetime(),
  /** Whether it was emailed: only when the user has an email and SMTP is set up. */
  emailed: z.boolean(),
});

export type CreatedRelinkLink = z.infer<typeof createdRelinkLinkSchema>;

const userParams = z.strictObject({ id: z.uuid() });

/* The admin's Users tab. Every route answers 404 for the admin's own account, which isn't a user. */

export const listUsersRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/users",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: usersSchema },
});

export const getUserRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/users/:id",
  access: "admin",
  recentSignIn: false,
  safe: true,
  params: userParams,
  responses: { 200: userSchema },
});

export const changeUserRoute = defineRoute({
  method: "PATCH",
  path: "/api/v1/admin/users/:id",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: userParams,
  body: changeUserRequestSchema,
  responses: { 200: userSchema },
});

/** Removes the account, its linked sign-ins, sessions and pending re-link links; the body chooses what happens to the home. */
export const removeUserRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/admin/users/:id",
  access: "admin",
  recentSignIn: true,
  safe: false,
  params: userParams,
  body: removeUserRequestSchema,
  responses: { 204: z.undefined() },
});

/** Refused (409 `last-sign-in-method`) for the user's last one: send a re-link link instead. */
export const removeUserLinkedSignInRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/admin/users/:id/linked-sign-ins/:link",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: z.strictObject({ id: z.uuid(), link: z.uuid() }),
  responses: { 204: z.undefined() },
});

/** A new single-use re-link link for the user, valid one day; any earlier pending one is revoked. Emailed when it can be. */
export const createRelinkLinkRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/users/:id/relink-links",
  access: "admin",
  recentSignIn: true,
  safe: false,
  params: userParams,
  responses: { 201: createdRelinkLinkSchema },
});

export const setDefaultQuotaRoute = defineRoute({
  method: "PUT",
  path: "/api/v1/admin/default-quota",
  access: "admin",
  recentSignIn: false,
  safe: false,
  body: defaultQuotaSchema,
  responses: { 200: defaultQuotaSchema },
});
