import {
  auditActions,
  auditOutcomes,
  routes,
  type AuditAction,
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
} from "@not-unreachable/design-system";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, buildQuery } from "../api/index.ts";
import { browserTimeZone, formatDateTime, localInputToIso, problemMessage } from "../lib/index.ts";
import { actionLabels, actorOf, auditTimelineGroups, outcomeLabels, titleOf } from "./audit-events.tsx";

export const AUDIT_PAGE_SIZE = 50;

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
          <Timeline groups={auditTimelineGroups(page.data.events, setSelected)} />
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
