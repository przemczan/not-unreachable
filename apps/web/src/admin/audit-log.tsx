import {
  auditActions,
  auditOutcomes,
  routes,
  type AuditAction,
  type AuditActorKind,
  type AuditEvent,
  type AuditFilter,
  type AuditOutcome,
} from "@not-unreachable/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionList,
  Drawer,
  EmptyState,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Select,
  Tag,
  Timeline,
  type BadgeProps,
  type TimelineGroup,
} from "@not-unreachable/design-system";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, buildQuery } from "../api/index.ts";
import { browserTimeZone, dayKeyOf, formatDateTime, formatDay, formatTime, localInputToIso, problemMessage } from "../lib/index.ts";

export const AUDIT_PAGE_SIZE = 50;

const actionLabels: Record<AuditAction, string> = {
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
function titleOf(event: AuditEvent): string {
  if (event.action === "second-factor.added" || event.action === "second-factor.removed") {
    const kind = event.details["kind"];
    const what = typeof kind === "string" ? secondFactorKindLabels[kind] : undefined;
    if (what !== undefined) return `${what} ${event.action === "second-factor.added" ? "added" : "removed"}`;
  }
  return actionLabels[event.action];
}

const outcomeLabels: Record<AuditOutcome, { readonly label: string; readonly tone: NonNullable<BadgeProps["tone"]> }> = {
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

function actorOf(event: AuditEvent): string {
  return event.actorUsername ?? actorKindLabels[event.actorKind];
}

function targetOf(event: AuditEvent): string | null {
  if (event.targetKind === null && event.targetId === null) return null;
  return [event.targetKind, event.targetId].filter((part) => part !== null).join(" ");
}

/** The filter controls' values, as typed. */
export interface AuditFilterDraft {
  readonly from: string;
  readonly to: string;
  readonly actorUsername: string;
  readonly action: AuditAction | "";
  readonly outcome: AuditOutcome | null;
}

const emptyDraft: AuditFilterDraft = { from: "", to: "", actorUsername: "", action: "", outcome: null };

/** The API's filter for the controls: `datetime-local` values are the browser's local time. */
export function auditFilterOf(draft: AuditFilterDraft): AuditFilter {
  const filter: AuditFilter = {};
  const from = localInputToIso(draft.from);
  const to = localInputToIso(draft.to);
  const actorUsername = draft.actorUsername.trim();
  if (from !== undefined) filter.from = from;
  if (to !== undefined) filter.to = to;
  if (actorUsername !== "") filter.actorUsername = actorUsername.slice(0, 64);
  if (draft.action !== "") filter.action = draft.action;
  if (draft.outcome !== null) filter.outcome = draft.outcome;
  return filter;
}

/** The CSV export of every event the filter matches: a plain GET the browser downloads with its cookie. */
export function exportHrefOf(filter: AuditFilter): string {
  return routes.exportAuditEvents.path + buildQuery(filter);
}

/** Downloads a file the server sends as an attachment; the page stays where it is. */
function download(href: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = "";
  anchor.click();
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function groupsOf(events: readonly AuditEvent[], onDetails: (event: AuditEvent) => void): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  for (const event of events) {
    const key = dayKeyOf(event.at);
    let group = groups.get(key);
    if (group === undefined) {
      group = { id: key, heading: formatDay(event.at), items: [] };
      groups.set(key, group);
    }
    const outcome = outcomeLabels[event.outcome];
    const target = targetOf(event);
    group.items.push({
      id: event.id,
      title: titleOf(event),
      description: [`by ${actorOf(event)}`, target, event.ip].filter((part) => part !== null).join(" · "),
      time: formatTime(event.at),
      dateTime: event.at,
      tone: event.outcome === "succeeded" ? "neutral" : outcome.tone,
      meta: (
        <Badge tone={outcome.tone} size="sm">
          {outcome.label}
        </Badge>
      ),
      action: (
        <Button variant="secondary" size="sm" onClick={() => onDetails(event)}>
          Details
        </Button>
      ),
    });
  }
  return [...groups.values()];
}

interface CursorStack {
  /** The filter the cursors belong to: another filter starts again at the first page. */
  readonly filterKey: string;
  /** The cursor of each page after the first that was opened, in order. */
  readonly cursors: readonly string[];
}

export function AuditLogPage() {
  const timeZone = browserTimeZone();
  const [draft, setDraft] = useState<AuditFilterDraft>(emptyDraft);
  const debouncedActor = useDebounced(draft.actorUsername, 300);
  const filter = auditFilterOf({ ...draft, actorUsername: debouncedActor });
  const filterKey = JSON.stringify(filter);
  const [stack, setStack] = useState<CursorStack>({ filterKey, cursors: [] });
  const cursors = stack.filterKey === filterKey ? stack.cursors : [];
  const cursor = cursors.at(-1);
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const page = useQuery({
    queryKey: ["admin", "audit-events", filter, cursor ?? null],
    queryFn: ({ signal }) =>
      api("listAuditEvents", { query: { ...filter, limit: AUDIT_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) }, signal }),
    placeholderData: keepPreviousData,
  });

  const update = (change: Partial<AuditFilterDraft>) => setDraft((current) => ({ ...current, ...change }));
  const filtered = Object.keys(auditFilterOf(draft)).length > 0;

  return (
    <>
      <PageHeader
        title="Audit log"
        description={`Who did what, and when. Times are in ${timeZone}.`}
        actions={
          <Button variant="secondary" iconLeft={<Icon name="download" size={14} />} onClick={() => download(exportHrefOf(filter))}>
            Export CSV
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <Input label="From" type="datetime-local" value={draft.from} onChange={(event) => update({ from: event.target.value })} />
        <Input label="To" type="datetime-local" value={draft.to} onChange={(event) => update({ to: event.target.value })} />
        <Input
          label="Actor"
          placeholder="Username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          value={draft.actorUsername}
          onChange={(event) => update({ actorUsername: event.target.value })}
        />
        <Select
          label="Action"
          value={draft.action}
          options={[{ value: "", label: "All actions" }, ...auditActions.map((action) => ({ value: action, label: actionLabels[action] }))]}
          onChange={(value) => update({ action: auditActions.find((action) => action === value) ?? "" })}
        />
        <fieldset aria-label="Outcome" className="m-0 flex h-8 items-center gap-1.5 border-0 p-0">
          {auditOutcomes.map((outcome) => (
            <Tag
              key={outcome}
              selected={draft.outcome === outcome}
              onClick={() => update({ outcome: draft.outcome === outcome ? null : outcome })}
            >
              {outcomeLabels[outcome].label}
            </Tag>
          ))}
        </fieldset>
        {filtered && (
          <Button variant="ghost" onClick={() => setDraft(emptyDraft)}>
            Clear filters
          </Button>
        )}
      </div>

      <Card padding="none" bodyClassName="p-5">
        {page.isPending ? (
          <p className="m-0 type-body-sm text-fg-3">Loading events…</p>
        ) : page.isError ? (
          <Alert
            tone="danger"
            title="The audit log could not be loaded"
            action={
              <Button variant="secondary" size="sm" onClick={() => void page.refetch()}>
                Try again
              </Button>
            }
          >
            {problemMessage(page.error, "Reload the page to try again.")}
          </Alert>
        ) : page.data.events.length === 0 ? (
          <EmptyState
            icon="search-x"
            title={filtered ? "No events match these filters" : "No events yet"}
            description={
              filtered ? "Try a wider time range, or clear a filter." : "Events appear here as people sign in and change settings."
            }
          />
        ) : (
          <Timeline groups={groupsOf(page.data.events, setSelected)} />
        )}
      </Card>

      {page.data !== undefined && (
        <Pagination
          aria-label="Audit log pages"
          loading={page.isFetching}
          hasPrevious={cursors.length > 0}
          hasNext={page.data.nextCursor !== null}
          onPrevious={() => setStack({ filterKey, cursors: cursors.slice(0, -1) })}
          onNext={() => {
            const next = page.data.nextCursor;
            if (next !== null) setStack({ filterKey, cursors: [...cursors, next] });
          }}
          summary={`Page ${cursors.length + 1} · ${page.data.events.length} ${page.data.events.length === 1 ? "event" : "events"}`}
        />
      )}

      <EventDrawer event={selected} timeZone={timeZone} onClose={() => setSelected(null)} />
    </>
  );
}

interface EventDrawerProps {
  readonly event: AuditEvent | null;
  readonly timeZone: string;
  readonly onClose: () => void;
}

/** Every field of one event; `details` as JSON text, never as markup (threat model, T4). */
function EventDrawer({ event, timeZone, onClose }: EventDrawerProps) {
  return (
    <Drawer
      open={event !== null}
      onClose={onClose}
      title={event === null ? undefined : titleOf(event)}
      description={event === null ? undefined : `${formatDateTime(event.at)} (${timeZone})`}
      width={520}
    >
      {event !== null && (
        <div className="flex flex-col gap-5">
          <DescriptionList
            labelWidth={130}
            items={[
              { label: "Time", value: `${formatDateTime(event.at)} (${timeZone})` },
              { label: "Time (UTC)", value: event.at, mono: true },
              { label: "Action", value: event.action, mono: true },
              {
                label: "Outcome",
                value: <Badge tone={outcomeLabels[event.outcome].tone}>{outcomeLabels[event.outcome].label}</Badge>,
              },
              { label: "Actor", value: actorOf(event) },
              { label: "Actor kind", value: event.actorKind },
              { label: "Actor account ID", value: event.actorAccountId ?? undefined, mono: true },
              { label: "Target kind", value: event.targetKind ?? undefined },
              { label: "Target ID", value: event.targetId ?? undefined, mono: true },
              { label: "IP address", value: event.ip ?? undefined, mono: true },
              { label: "User agent", value: event.userAgent ?? undefined },
              { label: "Event ID", value: event.id, mono: true, copyable: true },
            ]}
          />
          <section aria-label="Event details" className="flex flex-col gap-2">
            <h3 className="m-0 type-card-title text-fg-1">Details</h3>
            <pre className="m-0 overflow-x-auto rounded-control bg-surface-sunken p-3 type-mono whitespace-pre-wrap break-all text-fg-1">
              {JSON.stringify(event.details, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </Drawer>
  );
}
