import type { SessionSummary } from "@not-unreachable/contracts";
import { Alert, Badge, Button, Card, DataTable, Dialog, EmptyState, useToast, type DataTableColumn } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/index.ts";
import { formatDateTime, formatRelative, problemMessage } from "../lib/index.ts";

export const sessionsQueryKey = ["settings", "sessions"] as const;

/** What the confirm Dialog is about: one session, or every other one. */
type Confirming = { readonly kind: "one"; readonly session: SessionSummary } | { readonly kind: "others" } | null;

export function SessionsSettings() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>(null);
  const query = useQuery({ queryKey: sessionsQueryKey, queryFn: ({ signal }) => api("listSessions", { signal }) });

  const signOutOne = useMutation({
    mutationFn: (session: SessionSummary) => api("revokeSession", { params: { id: session.id } }),
    // The Alert shows the last sign-out's failure only.
    onMutate: (): void => signOutOthers.reset(),
    onSuccess: () => toast.show({ tone: "success", title: "Session signed out" }),
    onSettled: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    },
  });

  const signOutOthers = useMutation({
    mutationFn: () => api("revokeOtherSessions"),
    onMutate: (): void => signOutOne.reset(),
    onSuccess: ({ revoked }) =>
      toast.show({
        tone: "success",
        title: "Other sessions signed out",
        description: `${revoked} ${revoked === 1 ? "session" : "sessions"} signed out.`,
      }),
    onSettled: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    },
  });

  const failure = signOutOne.error ?? signOutOthers.error;
  const sessions = query.data?.sessions ?? [];
  const hasOthers = sessions.some((session) => !session.current);

  const columns: DataTableColumn<SessionSummary>[] = [
    {
      key: "device",
      header: "Device",
      wrap: true,
      render: (session) => (
        <span className="flex flex-wrap items-center gap-2">
          <span>{session.userAgent ?? "Unknown device"}</span>
          {session.current && (
            <Badge tone="accent" size="sm">
              This session
            </Badge>
          )}
        </span>
      ),
    },
    { key: "ip", header: "IP address", mono: true, render: (session) => session.ip ?? "—" },
    {
      key: "createdAt",
      header: "Signed in",
      render: (session) => <time dateTime={session.createdAt}>{formatDateTime(session.createdAt)}</time>,
    },
    {
      key: "lastSeenAt",
      header: "Last active",
      render: (session) => (
        <time dateTime={session.lastSeenAt} title={formatDateTime(session.lastSeenAt)}>
          {formatRelative(session.lastSeenAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (session) =>
        session.current ? null : (
          <Button variant="danger-ghost" size="sm" onClick={() => setConfirming({ kind: "one", session })}>
            Sign out
          </Button>
        ),
    },
  ];

  return (
    <>
      {failure !== null && <Alert tone="danger">{problemMessage(failure, "Signing out did not work. Try again.")}</Alert>}
      <Card
        title="Sessions"
        subtitle="The browsers signed in to your account."
        padding="none"
        actions={
          <Button variant="secondary" disabled={!hasOthers} onClick={() => setConfirming({ kind: "others" })}>
            Sign out all other sessions
          </Button>
        }
      >
        {query.isPending ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading sessions…</p>
        ) : query.isError ? (
          <div className="p-5">
            <Alert tone="danger">{problemMessage(query.error, "Your sessions could not be loaded. Reload the page to try again.")}</Alert>
          </div>
        ) : (
          <DataTable
            caption="Your sessions"
            columns={columns}
            rows={sessions}
            empty={<EmptyState compact title="No sessions" description="Sign in again to see this session here." />}
          />
        )}
      </Card>

      <Dialog
        open={confirming?.kind === "one"}
        onClose={() => setConfirming(null)}
        tone="danger"
        title="Sign out this session?"
        description="The device will need to sign in again to use NotUnreachable."
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={signOutOne.isPending}
              onClick={() => {
                if (confirming?.kind === "one") signOutOne.mutate(confirming.session);
              }}
            >
              Sign out session
            </Button>
          </>
        }
      />
      <Dialog
        open={confirming?.kind === "others"}
        onClose={() => setConfirming(null)}
        tone="danger"
        title="Sign out all other sessions?"
        description="Every other device will need to sign in again. This session stays signed in."
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={signOutOthers.isPending} onClick={() => signOutOthers.mutate()}>
              Sign out other sessions
            </Button>
          </>
        }
      />
    </>
  );
}
