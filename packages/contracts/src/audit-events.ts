import { z } from "zod";
import { defineRoute } from "./route.ts";

/** Every action the audit log records so far (threat model, T12); later Tasks add theirs. */
export const auditActions = [
  "setup-link.issued",
  "setup.completed",
  "admin.reset",
  "sign-in.succeeded",
  "sign-in.failed",
  "sign-in.locked",
  "sign-out",
  "session.revoked",
  "password.changed",
  "second-factor.added",
  "second-factor.removed",
  "second-factor.failed",
  "second-factor.recovery-code-used",
  "recovery-codes.regenerated",
  "account.changed",
  "settings.changed",
  "rate-limit.triggered",
  "audit.purged",
  "system.started",
  "system.migrated",
  "system.key-rotated",
  "resource.added",
  "resource.changed",
  "resource.removed",
  "resource.mount-failed",
  "folder.allowed",
  "home-root.changed",
  "sso-provider.changed",
  "linked-sign-in.added",
  "linked-sign-in.removed",
  "invitation.created",
  "invitation.resent",
  "invitation.revoked",
  "invitation.accepted",
  "invitation.refused",
  "relink.created",
  "relink.used",
  "account.created",
  "account.disabled",
  "account.enabled",
  "account.deleted",
  "mail.test-sent",
  "file.uploaded",
  "file.deleted",
  "share-link.created",
  "share-link.changed",
  "share-link.revoked",
  "share-link.downloaded",
  "share-link.password-failed",
  "share-link.locked",
  "update.requested",
  "update.finished",
] as const;

export type AuditAction = (typeof auditActions)[number];

export const auditActorKinds = ["account", "share-link", "anonymous", "system"] as const;
export type AuditActorKind = (typeof auditActorKinds)[number];

export const auditOutcomes = ["succeeded", "failed", "denied"] as const;
export type AuditOutcome = (typeof auditOutcomes)[number];

export const AUDIT_PAGE_LIMIT_MAX = 200;

export const auditEventSchema = z.strictObject({
  id: z.uuid(),
  at: z.iso.datetime(),
  actorKind: z.enum(auditActorKinds),
  actorAccountId: z.uuid().nullable(),
  /** The actor's username when the event happened. */
  actorUsername: z.string().nullable(),
  action: z.enum(auditActions),
  targetKind: z.string().nullable(),
  targetId: z.string().nullable(),
  outcome: z.enum(auditOutcomes),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** Never secrets (T12); the UI shows every value as text only (T4). */
  details: z.record(z.string(), z.json()),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

/** The filters the Audit log screen and its CSV export share. Times are inclusive `from`, exclusive `to`. */
export const auditFilterSchema = z.strictObject({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  actorKind: z.enum(auditActorKinds).optional(),
  actorUsername: z.string().min(1).max(64).optional(),
  action: z.enum(auditActions).optional(),
  outcome: z.enum(auditOutcomes).optional(),
});

export type AuditFilter = z.infer<typeof auditFilterSchema>;

export const auditPageQuerySchema = auditFilterSchema.extend({
  /** Opaque; from the previous page's `nextCursor`. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_LIMIT_MAX).default(50),
});

export const auditPageSchema = z.strictObject({
  /** Newest first. */
  events: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
});

export type AuditPage = z.infer<typeof auditPageSchema>;

export const listAuditEventsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/audit-events",
  access: "admin",
  recentSignIn: false,
  safe: true,
  query: auditPageQuerySchema,
  responses: { 200: auditPageSchema },
});

/** `text/csv` as an attachment; cells that a spreadsheet would read as a formula are escaped. */
export const exportAuditEventsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/audit-events/export.csv",
  access: "admin",
  recentSignIn: false,
  safe: true,
  query: auditFilterSchema,
  responses: { 200: z.string() },
});
