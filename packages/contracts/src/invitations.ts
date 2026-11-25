import { z } from "zod";
import { displayNameSchema, emailSchema, usernameSchema } from "./accounts.ts";
import { defineRoute } from "./route.ts";
import { signInProviderSchema, ssoRedirectSchema } from "./sso.ts";

/** How long a new invitation stays valid, in days (domain.md, Glossary). */
export const invitationExpiryDays = [1, 7, 30] as const;
export type InvitationExpiryDays = (typeof invitationExpiryDays)[number];
export const DEFAULT_INVITATION_EXPIRY_DAYS = 7 satisfies InvitationExpiryDays;

/** A re-link link is valid for one day. */
export const RELINK_LINK_LIFETIME_DAYS = 1;

export const invitationStates = ["pending", "accepted", "expired", "revoked"] as const;
export type InvitationState = (typeof invitationStates)[number];

/**
 * An invitation or re-link link token in a URL: 256 random bits, base64url (43 characters). The
 * schema is loose on purpose: a malformed token gets the same `invitation-invalid` answer as an
 * unknown one (threat model, T1), never a validation problem.
 */
export const linkTokenSchema = z.string().min(1).max(200);

const tokenParams = z.strictObject({ token: linkTokenSchema });
const invitationParams = z.strictObject({ id: z.uuid() });

/** An invitation as the admin's Invitations tab lists it; never its token. */
export const invitationSchema = z.strictObject({
  id: z.uuid(),
  /**
   * Who it is meant for. It never links a sign-in to the account; with `verifyEmail`, accepting needs
   * a provider-verified email equal to it (threat model, T9).
   */
  email: z.string().nullable(),
  /** The admin chose to email it: only these can be sent again. */
  sendByEmail: z.boolean(),
  /** Accepting needs the SSO provider to report this email as verified; always on with `sendByEmail`. */
  verifyEmail: z.boolean(),
  state: z.enum(invitationStates),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  /** The username of the account it created, while that account exists. */
  acceptedUsername: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export type Invitation = z.infer<typeof invitationSchema>;

export const invitationsSchema = z.strictObject({
  /** Newest first. */
  invitations: z.array(invitationSchema),
});

export type Invitations = z.infer<typeof invitationsSchema>;

export const createInvitationRequestSchema = z
  .strictObject({
    email: emailSchema.optional(),
    expiresInDays: z.literal([...invitationExpiryDays]).default(DEFAULT_INVITATION_EXPIRY_DAYS),
    /** Email the link to `email`; needs SMTP set up (409 `smtp-not-configured`). */
    sendByEmail: z.boolean().default(false),
    /** Require a provider-verified email equal to `email`; always on with `sendByEmail`. */
    verifyEmail: z.boolean().default(false),
  })
  .superRefine(({ email, sendByEmail, verifyEmail }, context) => {
    if (sendByEmail && email === undefined) {
      context.addIssue({ code: "custom", path: ["sendByEmail"], message: "Sending the invitation needs an email." });
    }
    if (verifyEmail && email === undefined) {
      context.addIssue({ code: "custom", path: ["verifyEmail"], message: "Requiring a verified email needs an email." });
    }
    if (sendByEmail && !verifyEmail) {
      context.addIssue({ code: "custom", path: ["verifyEmail"], message: "An invitation sent by email always requires a verified email." });
    }
  });

export type CreateInvitationRequest = z.input<typeof createInvitationRequestSchema>;

/** The whole link, built from `PUBLIC_ORIGIN`, for the admin to copy. */
export const invitationLinkSchema = z.strictObject({ link: z.url() });

export type InvitationLink = z.infer<typeof invitationLinkSchema>;

export const createdInvitationSchema = z.strictObject({
  invitation: invitationSchema,
  link: z.url(),
  /** Whether it was emailed: only with `sendByEmail`, and false when sending failed. */
  emailed: z.boolean(),
});

export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

/** What the invitation page needs once the link checks out. */
export const invitationOfferSchema = z.strictObject({
  providers: z.array(signInProviderSchema),
  /** From the invitation's email, when it makes a free, valid username. */
  suggestedUsername: z.string().nullable(),
  /** Accepting needs a verified email at the provider equal to the invitation's, which the page never shows. */
  verifyEmail: z.boolean(),
});

export type InvitationOffer = z.infer<typeof invitationOfferSchema>;

export const acceptInvitationRequestSchema = z.strictObject({
  providerId: z.uuid(),
  username: usernameSchema,
  displayName: displayNameSchema,
});

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

/** What the re-link page needs once the link checks out. */
export const relinkOfferSchema = z.strictObject({ providers: z.array(signInProviderSchema) });

export type RelinkOffer = z.infer<typeof relinkOfferSchema>;

export const startRelinkRequestSchema = z.strictObject({ providerId: z.uuid() });

/*
 * Where the SSO callback sends the browser when accepting or re-linking fails: back to the link's
 * own page, with `?error=`. Success lands on `SSO_SIGN_IN_COMPLETE_PATH`, signed in.
 */
export const invitationPath = (token: string): string => `/invitation/${encodeURIComponent(token)}`;
export const relinkPath = (token: string): string => `/relink/${encodeURIComponent(token)}`;

/** The `?error=` the invitation page is sent back with. */
export const acceptFailures = [
  "invitation-invalid",
  "username-taken",
  "username-reserved",
  "identity-already-linked",
  "email-not-verified",
  "email-mismatch",
  "accept-failed",
] as const;
export type AcceptFailure = (typeof acceptFailures)[number];

/** The `?error=` the re-link page is sent back with. */
export const relinkFailures = ["invitation-invalid", "identity-already-linked", "relink-failed"] as const;
export type RelinkFailure = (typeof relinkFailures)[number];

/* The admin's Invitations tab. */

export const listInvitationsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/invitations",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: invitationsSchema },
});

/**
 * Refused (409 `home-root-not-set`) while no home root is set, and (409 `smtp-not-configured`) when
 * `sendByEmail` asks to email it without SMTP set up. Emails the link only with `sendByEmail`.
 */
export const createInvitationRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/invitations",
  access: "admin",
  recentSignIn: false,
  safe: false,
  body: createInvitationRequestSchema,
  responses: { 201: createdInvitationSchema },
});

/** A pending invitation's link again, from its envelope copy (409 `invitation-invalid` once it isn't pending). */
export const getInvitationLinkRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/invitations/:id/link",
  access: "admin",
  recentSignIn: false,
  safe: true,
  params: invitationParams,
  responses: { 200: invitationLinkSchema },
});

/** Emails a pending invitation sent by email again (409 `smtp-not-configured`, 409 `invitation-invalid`). */
export const resendInvitationRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/invitations/:id/resend",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: invitationParams,
  responses: { 200: invitationSchema },
});

/** Revokes a pending invitation; it stays in the list as `revoked` (409 `invitation-invalid` once it isn't pending). */
export const revokeInvitationRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/admin/invitations/:id",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: invitationParams,
  responses: { 204: z.undefined() },
});

/*
 * The public invitation and re-link pages (threat model, T1, T11). An unknown, expired, used or
 * revoked link gets the same 404 `invitation-invalid`, byte for byte.
 */

export const getInvitationRoute = defineRoute({
  method: "GET",
  path: "/api/v1/invitations/:token",
  access: "public",
  recentSignIn: false,
  safe: true,
  params: tokenParams,
  responses: { 200: invitationOfferSchema },
});

/**
 * Checks the username (409 `username-taken`, `username-reserved`) and starts signing in at the
 * provider (502 `sso-provider-unreachable` when it can't be reached); the callback creates the
 * account, all or nothing.
 */
export const acceptInvitationRoute = defineRoute({
  method: "POST",
  path: "/api/v1/invitations/:token/accept",
  access: "public",
  recentSignIn: false,
  safe: false,
  params: tokenParams,
  body: acceptInvitationRequestSchema,
  responses: { 200: ssoRedirectSchema },
});

export const getRelinkRoute = defineRoute({
  method: "GET",
  path: "/api/v1/relink/:token",
  access: "public",
  recentSignIn: false,
  safe: true,
  params: tokenParams,
  responses: { 200: relinkOfferSchema },
});

/**
 * Starts signing in at the provider (502 `sso-provider-unreachable` when it can't be reached); the
 * callback links the new identity in place of the old ones.
 */
export const startRelinkRoute = defineRoute({
  method: "POST",
  path: "/api/v1/relink/:token/start",
  access: "public",
  recentSignIn: false,
  safe: false,
  params: tokenParams,
  body: startRelinkRequestSchema,
  responses: { 200: ssoRedirectSchema },
});
