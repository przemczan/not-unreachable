import type { AuditAction, AuditActorKind, AuditEvent, AuditOutcome } from "@not-unreachable/contracts";
import { Badge, Button, type BadgeProps, type TimelineGroup } from "@not-unreachable/design-system";
import { dayKeyOf, formatDay, formatTime } from "../lib/index.ts";

/** How the admin interface words audit events: the Audit log page and the Dashboard's Recent activity. */
export const actionLabels: Record<AuditAction, string> = {
  "setup-link.issued": "Setup link issued",
  "setup.completed": "Setup completed",
  "admin.reset": "Admin password reset",
  "sign-in.succeeded": "Signed in",
  "sign-in.failed": "Sign-in failed",
  "sign-in.locked": "Account locked",
  "sign-out": "Signed out",
  "session.revoked": "Session signed out",
  "password.changed": "Password changed",
  "second-factor.added": "Second factor added",
  "second-factor.removed": "Second factor removed",
  "second-factor.failed": "Two-step sign-in failed",
  "second-factor.recovery-code-used": "Recovery code used",
  "recovery-codes.regenerated": "Recovery codes regenerated",
  "account.changed": "Account changed",
  "settings.changed": "Settings changed",
  "resource.added": "Resource added",
  "resource.changed": "Resource changed",
  "resource.removed": "Resource removed",
  "resource.mount-failed": "Share mount failed",
  "folder.allowed": "Folder allowed",
  "home-root.changed": "Home root changed",
  "sso-provider.changed": "Sign-in provider changed",
  "linked-sign-in.added": "Sign-in linked",
  "linked-sign-in.removed": "Sign-in unlinked",
  "invitation.created": "Invitation created",
  "invitation.resent": "Invitation resent",
  "invitation.revoked": "Invitation revoked",
  "invitation.accepted": "Invitation accepted",
  "invitation.refused": "Invitation refused",
  "relink.created": "Re-link link created",
  "relink.used": "Re-link link used",
  "account.created": "Account created",
  "account.disabled": "Account disabled",
  "account.enabled": "Account enabled",
  "account.deleted": "Account removed",
  "mail.test-sent": "Test email sent",
  "file.uploaded": "File uploaded",
  "file.deleted": "File deleted",
  "share-link.created": "Share link created",
  "share-link.changed": "Share link changed",
  "share-link.revoked": "Share link revoked",
  "share-link.downloaded": "Share link downloaded",
  "share-link.password-failed": "Wrong share link password",
  "share-link.locked": "Share link locked",
  "update.requested": "Update requested",
  "update.finished": "Update finished",
  "rate-limit.triggered": "Rate limit reached",
  "audit.purged": "Old events deleted",
  "system.started": "System started",
  "system.migrated": "Database migrated",
  "system.key-rotated": "Key rotated",
};

/** What a second factor's event says it was about, by its `kind`. */
const secondFactorKindLabels: Readonly<Record<string, string>> = {
  totp: "Authenticator app",
  passkey: "Passkey",
  recoveryCodes: "Recovery codes",
};

/** An event's title: its action, naming the second factor's kind for those events. */
export function titleOf(event: AuditEvent): string {
  if (event.action === "second-factor.added" || event.action === "second-factor.removed") {
    const kind = event.details["kind"];
    const what = typeof kind === "string" ? secondFactorKindLabels[kind] : undefined;
    if (what !== undefined) return `${what} ${event.action === "second-factor.added" ? "added" : "removed"}`;
  }
  return actionLabels[event.action];
}

export const outcomeLabels: Record<AuditOutcome, { readonly label: string; readonly tone: NonNullable<BadgeProps["tone"]> }> = {
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  denied: { label: "Denied", tone: "warning" },
};

/** An actor without a username, by kind. */
const actorKindLabels: Record<AuditActorKind, string> = {
  account: "Unknown account",
  "share-link": "Share link",
  anonymous: "Anonymous",
  system: "System",
};

export function actorOf(event: AuditEvent): string {
  return event.actorUsername ?? actorKindLabels[event.actorKind];
}

function targetOf(event: AuditEvent): string | null {
  if (event.targetKind === null && event.targetId === null) return null;
  return [event.targetKind, event.targetId].filter((part) => part !== null).join(" ");
}

/**
 * Events as Timeline groups, one per local day, newest first as given: title, actor, target, IP,
 * time and outcome. With `onDetails`, each event has a Details button that calls it.
 */
export function auditTimelineGroups(events: readonly AuditEvent[], onDetails?: (event: AuditEvent) => void): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  for (const event of events) {
    const key = dayKeyOf(event.at);
    let group = groups.get(key);
    if (group === undefined) {
      group = { id: key, heading: formatDay(event.at), items: [] };
      groups.set(key, group);
    }
    const outcome = outcomeLabels[event.outcome];
    group.items.push({
      id: event.id,
      title: titleOf(event),
      description: [`by ${actorOf(event)}`, targetOf(event), event.ip].filter((part) => part !== null).join(" · "),
      time: formatTime(event.at),
      dateTime: event.at,
      tone: event.outcome === "succeeded" ? "neutral" : outcome.tone,
      meta: (
        <Badge tone={outcome.tone} size="sm">
          {outcome.label}
        </Badge>
      ),
      ...(onDetails === undefined
        ? {}
        : {
            action: (
              <Button variant="secondary" size="sm" onClick={() => onDetails(event)}>
                Details
              </Button>
            ),
          }),
    });
  }
  return [...groups.values()];
}
