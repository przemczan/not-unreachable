import {
  allowFolderRefusals,
  entryKinds,
  homeFolderChoices,
  resourceKinds,
  secondFactorKinds,
  secondFactorMethods,
  shareFailures,
  shareLinkAccesses,
  shareLinkKinds,
  ssoProviderKinds,
  updateReasons,
  updateResults,
  uploadConflictChoices,
  type AuditAction,
  type AuditActorKind,
  type AuditOutcome,
} from "@not-unreachable/contracts";
import { z } from "zod";

const setupPurpose = z.enum(["first-run", "admin-reset"]);

/**
 * The details each action records, strict so nothing else slips in. Never a password, code,
 * token, secret or file content (threat model, T12); a test checks the field names.
 */
export const auditDetailsSchemas = {
  "setup-link.issued": z.strictObject({ purpose: setupPurpose, expiresAt: z.iso.datetime() }),
  "setup.completed": z.strictObject({ purpose: setupPurpose }),
  "admin.reset": z.strictObject({ revokedSessions: z.int().min(0), removedSignInMethods: z.array(z.string()) }),
  /**
   * Recorded once the sign-in is complete: after the second factor, which it names, for the admin;
   * at the SSO callback for a user, who has none (null).
   */
  "sign-in.succeeded": z.union([
    z.strictObject({ method: z.literal("password"), secondFactor: z.enum(secondFactorMethods) }),
    z.strictObject({ method: z.literal("sso"), secondFactor: z.enum(secondFactorMethods).nullable() }),
    /** Passwordless: the passkey with user verification counts as both steps, so there is no second one (null). */
    z.strictObject({ method: z.literal("passkey"), secondFactor: z.null() }),
  ]),
  /** An SSO failure names the provider when the callback's id is one; the browser only ever sees `sign-in-failed` (T9). */
  "sign-in.failed": z.union([
    z.strictObject({
      method: z.literal("password"),
      reason: z.enum(["unknown-account", "wrong-password", "disabled", "no-password", "delayed", "locked"]),
    }),
    z.strictObject({
      method: z.literal("sso"),
      providerId: z.uuid().nullable(),
      reason: z.enum([
        "unknown-provider",
        "disabled-provider",
        "invalid-flow",
        "provider-error",
        "invalid-response",
        "unknown-identity",
        "disabled",
      ]),
    }),
    /** Passwordless; the browser only ever sees `sign-in-failed` (T1). */
    z.strictObject({
      method: z.literal("passkey"),
      reason: z.enum(["invalid-challenge", "unknown-passkey", "user-handle-mismatch", "not-verified", "counter", "disabled"]),
    }),
  ]),
  "sign-in.locked": z.strictObject({ failures: z.int().min(1), lockedUntil: z.iso.datetime() }),
  "sign-out": z.strictObject({}),
  "session.revoked": z.strictObject({
    sessionId: z.uuid(),
    reason: z.enum([
      "signed-out-elsewhere",
      "signed-out-others",
      "password-changed",
      "admin-reset",
      "second-factor-limit",
      "account-disabled",
      "account-removed",
      "relinked",
    ]),
  }),
  "password.changed": z.strictObject({ revokedSessions: z.int().min(0) }),
  /** The target is the factor. */
  "second-factor.added": z.strictObject({ kind: z.enum(secondFactorKinds) }),
  "second-factor.removed": z.strictObject({
    kind: z.enum([...secondFactorKinds, "recoveryCodes"]),
    reason: z.enum(["removed-in-settings", "reset-admin"]),
  }),
  /**
   * `limit-reached` when this failure passed a limit, which revokes a pending session. `reason`
   * `counter` when a passkey's signature counter didn't increase, a sign of a cloned authenticator.
   */
  "second-factor.failed": z.strictObject({
    method: z.enum(secondFactorMethods),
    during: z.enum(["sign-in", "enrolment", "confirm"]),
    limitReached: z.boolean(),
    reason: z.literal("counter").optional(),
  }),
  "second-factor.recovery-code-used": z.strictObject({ remaining: z.int().min(0) }),
  "recovery-codes.regenerated": z.strictObject({ count: z.int().min(1) }),
  /** The account's own profile fields, or its quota as the admin sets it. */
  "account.changed": z.strictObject({ fields: z.array(z.enum(["email", "displayName", "quota"])).min(1) }),
  /** The target is the new account, made by accepting the invitation it names. */
  "account.created": z.strictObject({ username: z.string(), invitationId: z.uuid() }),
  /** The target is the account. */
  "account.disabled": z.strictObject({ revokedSessions: z.int().min(0) }),
  "account.enabled": z.strictObject({}),
  /** The target is the removed account; what happened to its home, as the admin chose. */
  "account.deleted": z.strictObject({ username: z.string(), homeFolder: z.enum(homeFolderChoices) }),
  /** The target is the invitation; never its token or link (threat model, T12). */
  "invitation.created": z.strictObject({
    expiresAt: z.iso.datetime(),
    hasEmail: z.boolean(),
    sendByEmail: z.boolean(),
    verifyEmail: z.boolean(),
    emailed: z.boolean(),
  }),
  "invitation.resent": z.strictObject({}),
  "invitation.revoked": z.strictObject({}),
  "invitation.accepted": z.strictObject({ accountId: z.uuid(), username: z.string() }),
  /** Accepting was refused for the email check (T9); never the provider's emails. */
  "invitation.refused": z.strictObject({ reason: z.enum(["email-not-verified", "email-mismatch"]), providerId: z.uuid() }),
  /** The target is the user; never the link. */
  "relink.created": z.strictObject({
    relinkId: z.uuid(),
    expiresAt: z.iso.datetime(),
    emailed: z.boolean(),
    revokedEarlier: z.int().min(0),
  }),
  "relink.used": z.strictObject({
    relinkId: z.uuid(),
    providerId: z.uuid(),
    removedLinks: z.int().min(0),
    revokedSessions: z.int().min(0),
  }),
  /** Which settings changed, never their values; the mail settings name their changed fields (the password's too, never its value). */
  "settings.changed": z.union([
    z.strictObject({ keys: z.array(z.string()).min(1) }),
    z.strictObject({
      setting: z.literal("mail"),
      fields: z.array(z.enum(["host", "port", "tlsMode", "username", "password", "fromAddress"])).min(1),
    }),
  ]),
  /** Once per key per window. */
  "rate-limit.triggered": z.strictObject({ limit: z.string(), key: z.string() }),
  "audit.purged": z.strictObject({ count: z.int().min(0), before: z.iso.datetime() }),
  "system.started": z.strictObject({ version: z.string() }),
  "system.migrated": z.strictObject({ migrations: z.array(z.string()) }),
  "system.key-rotated": z.strictObject({ oldKeyId: z.string(), newKeyId: z.string(), reencrypted: z.int().min(0) }),
  /** Resources: the target is the resource; never a credential (threat model, T12). */
  "resource.added": z.strictObject({ kind: z.enum(resourceKinds), name: z.string() }),
  /** Which fields changed, never their values (an SMB password above all). */
  "resource.changed": z.strictObject({
    fields: z
      .array(z.enum(["name", "localPath", "host", "share", "subfolder", "username", "password", "domain", "protocol", "encrypt"]))
      .min(1),
  }),
  "resource.removed": z.strictObject({ kind: z.enum(resourceKinds), name: z.string() }),
  /** An SMB share's mount failed: at startup, on a retry, or saving it; the actor is the system or the admin. */
  "resource.mount-failed": z.strictObject({ reason: z.enum(shareFailures) }),
  /**
   * A folder the admin allowed from the admin interface, or tried to: `path` as typed, `realPath`
   * once the checks found it, and how it ended (a refusal is one of `allowFolderRefusals`).
   */
  "folder.allowed": z.strictObject({
    path: z.string(),
    realPath: z.string().nullable(),
    result: z.enum([
      "allowed",
      "already-writable",
      "rate-limited",
      "wrong-password",
      "wrong-second-factor",
      "too-many-attempts",
      "helper-unavailable",
      "helper-failed",
      /** Anything unexpected, such as the server too busy to check the password. */
      "error",
      ...allowFolderRefusals,
    ]),
  }),
  "home-root.changed": z.strictObject({
    previousResourceId: z.uuid().nullable(),
    previousSubpath: z.string().nullable(),
    subpath: z.string(),
  }),
  /** The target is the provider. Which fields changed, never their values (the client secret above all). */
  "sso-provider.changed": z.strictObject({
    change: z.enum(["added", "changed", "removed"]),
    kind: z.enum(ssoProviderKinds),
    name: z.string(),
    fields: z.array(z.enum(["name", "issuer", "clientId", "clientSecret", "enabled"])),
  }),
  /** The target is the account; the identity's subject is never recorded. */
  "linked-sign-in.added": z.strictObject({ linkedSignInId: z.uuid(), providerId: z.uuid(), kind: z.enum(ssoProviderKinds) }),
  "linked-sign-in.removed": z.strictObject({ linkedSignInId: z.uuid(), providerId: z.uuid(), kind: z.enum(ssoProviderKinds) }),
  /** Succeeded or failed; the recipient is the admin's own address, so nothing else is recorded. */
  "mail.test-sent": z.strictObject({}),
  /** `resourceId` is null for a user's upload into their own home; `path` is relative to the resource or the home. */
  "file.uploaded": z.strictObject({
    resourceId: z.uuid().nullable(),
    path: z.string(),
    size: z.int().min(0),
    onConflict: z.enum(uploadConflictChoices),
  }),
  "file.deleted": z.strictObject({
    resourceId: z.uuid().nullable(),
    path: z.string(),
    kind: z.enum(entryKinds),
    recursive: z.boolean(),
  }),
  /**
   * The target is the link; never its token or password. `allowedUserIds` are the users a "Selected
   * users" link was shared with, ordered by username; empty for any other access.
   */
  "share-link.created": z.strictObject({
    resourceId: z.uuid(),
    path: z.string(),
    kind: z.enum(shareLinkKinds),
    hasPassword: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
    access: z.enum(shareLinkAccesses),
    allowedUserIds: z.array(z.uuid()),
  }),
  /** `access` is among the fields when the link access or its list of users changed; the rest is the link as it is now. */
  "share-link.changed": z.strictObject({
    fields: z.array(z.enum(["expiry", "password", "access"])),
    hasPassword: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
    unlocksDeleted: z.int().min(0),
    access: z.enum(shareLinkAccesses),
    allowedUserIds: z.array(z.uuid()),
  }),
  "share-link.revoked": z.strictObject({}),
  /**
   * `path` is relative to the shared folder; empty for a file link's own file. The actor is the
   * signed-in account for a link whose access isn't "anyone", else the link.
   */
  "share-link.downloaded": z.strictObject({ path: z.string() }),
  "share-link.password-failed": z.strictObject({ limitReached: z.boolean() }),
  "share-link.locked": z.strictObject({ reason: z.enum(["per-ip", "per-link"]), lockedUntil: z.iso.datetime() }),
  /**
   * Every install request from Settings whose body is valid (deployment.md, "The update contracts"):
   * `accepted`, `denied` (a failed proof, or past the limit), `refused` (409) or `error` (anything
   * unexpected, such as the server too busy to check the password). `from` is the running version,
   * `to` the one asked for.
   */
  "update.requested": z.strictObject({
    requestId: z.uuid(),
    from: z.string(),
    to: z.string(),
    outcome: z.enum(["accepted", "denied", "refused", "error"]),
  }),
  /** Once per accepted request, by whichever server sees it finished first; the actor is the admin who asked. */
  "update.finished": z.strictObject({
    requestId: z.uuid(),
    from: z.string(),
    to: z.string(),
    result: z.enum(updateResults),
    reason: z.enum(updateReasons).nullable(),
    signingKey: z.string().nullable(),
  }),
} as const satisfies Record<AuditAction, z.ZodType>;

export type AuditDetails<Action extends AuditAction> = z.input<(typeof auditDetailsSchemas)[Action]>;

/** Who acted. An account carries its username, kept with the event. */
export type AuditActor =
  | { readonly kind: "account"; readonly accountId: string; readonly username: string }
  | { readonly kind: Exclude<AuditActorKind, "account"> };

/** The account behind a request (the session guard's caller), as an actor. */
export function actorOf(caller: { readonly accountId: string; readonly username: string }): AuditActor {
  return { kind: "account", accountId: caller.accountId, username: caller.username };
}

export interface AuditTarget {
  readonly kind: string;
  readonly id: string;
}

/** Where a request came from, when the event comes from one. */
export interface AuditOrigin {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuditEventInput<Action extends AuditAction> {
  readonly action: Action;
  readonly actor: AuditActor;
  readonly outcome: AuditOutcome;
  readonly target?: AuditTarget;
  readonly origin?: AuditOrigin;
  readonly details: AuditDetails<Action>;
}
