import type { Dashboard } from "@not-unreachable/contracts";
import { Alert, Button, Card, EmptyState, PageHeader, Timeline } from "@not-unreachable/design-system";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { Link } from "react-router";
import { api } from "../api/index.ts";
import { problemMessage } from "../lib/index.ts";
import { auditTimelineGroups } from "./audit-events.tsx";

/** How many of the newest audit events Recent activity shows. */
export const RECENT_ACTIVITY_LIMIT = 5;

export const dashboardQueryKey = ["admin", "dashboard"] as const;
const recentActivityQueryKey = ["admin", "audit-events", "recent"] as const;

const count = new Intl.NumberFormat();

/** "1 download", "1,234 downloads". */
function plural(value: number, one: string, many: string): string {
  return `${count.format(value)} ${value === 1 ? one : many}`;
}

interface StatCardProps {
  readonly title: string;
  readonly value: number;
  /** What the value counts, and the rest of the breakdown, as muted lines. */
  readonly lines: readonly string[];
  readonly href: string;
  readonly linkLabel: string;
}

/** One count of the instance, with its breakdown and a link to the page that manages it. */
function StatCard({ title, value, lines, href, linkLabel }: StatCardProps) {
  return (
    <Card
      title={title}
      footer={
        <Link to={href} className="text-link hover:text-link-hover">
          {linkLabel}
        </Link>
      }
    >
      <p className="m-0 type-metric text-fg-1 tabular-nums">{count.format(value)}</p>
      {lines.map((line) => (
        <p key={line} className="m-0 mt-1 type-body-sm text-fg-3">
          {line}
        </p>
      ))}
    </Card>
  );
}

function StatCards({ dashboard }: { readonly dashboard: Dashboard }) {
  const { users, pendingInvitations, resources, shareLinks } = dashboard;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Users"
        value={users.active}
        lines={[`active · ${count.format(users.disabled)} disabled`]}
        href="/admin/users"
        linkLabel="View users"
      />
      <StatCard
        title="Invitations"
        value={pendingInvitations}
        lines={["pending"]}
        href="/admin/users/invitations"
        linkLabel="View invitations"
      />
      <StatCard
        title="Resources"
        value={resources.available}
        lines={[`available · ${count.format(resources.unavailable)} unavailable`]}
        href="/admin/resources"
        linkLabel="View resources"
      />
      <StatCard
        title="Share links"
        value={shareLinks.active}
        lines={[
          `active · ${count.format(shareLinks.expired)} expired · ${count.format(shareLinks.revoked)} revoked · ${count.format(shareLinks.locked)} locked`,
          `${plural(shareLinks.downloads, "download", "downloads")} in total`,
        ]}
        href="/admin/share-links"
        linkLabel="View share links"
      />
    </div>
  );
}

interface LoadErrorProps {
  readonly title: string;
  readonly error: Error;
  readonly onRetry: () => void;
}

function LoadError({ title, error, onRetry }: LoadErrorProps) {
  return (
    <Alert
      tone="danger"
      title={title}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {problemMessage(error, "Reload the page to try again.")}
    </Alert>
  );
}

function Counts() {
  const query = useQuery({ queryKey: dashboardQueryKey, queryFn: ({ signal }) => api("getDashboard", { signal }) });
  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading counts…</p>;
  if (query.isError) {
    return <LoadError title="The counts could not be loaded" error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <StatCards dashboard={query.data} />;
}

function RecentActivity() {
  const query = useQuery({
    queryKey: recentActivityQueryKey,
    queryFn: ({ signal }) => api("listAuditEvents", { query: { limit: RECENT_ACTIVITY_LIMIT }, signal }),
  });

  let body: React.ReactNode;
  if (query.isPending) body = <p className="m-0 type-body-sm text-fg-3">Loading events…</p>;
  else if (query.isError) {
    body = <LoadError title="Recent activity could not be loaded" error={query.error} onRetry={() => void query.refetch()} />;
  } else if (query.data.events.length === 0) {
    body = (
      <EmptyState
        compact
        icon="scroll-text"
        title="No activity yet"
        description="Events appear here as people sign in and change settings."
      />
    );
  } else body = <Timeline groups={auditTimelineGroups(query.data.events)} />;

  return (
    <Card
      title="Recent activity"
      subtitle="The newest events of the audit log."
      actions={
        <Link to="/admin/audit-log" className="type-body-sm text-link hover:text-link-hover">
          View audit log
        </Link>
      }
    >
      {body}
    </Card>
  );
}

/** Admin → Dashboard: the instance at a glance, where the admin lands after signing in. */
export function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="Your NotUnreachable at a glance." />
      <Counts />
      <RecentActivity />
    </>
  );
}
