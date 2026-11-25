import { linkFailures, type LinkFailure, type LinkedSignIn, type SignInProvider } from "@not-unreachable/contracts";
import { Alert, Badge, Button, Card, DataTable, Dialog, EmptyState, useToast, type DataTableColumn } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api/index.ts";
import {
  browserNavigation,
  formatDateTime,
  formatRelative,
  problemMessage,
  signInProvidersQuery,
  ssoProblemMessage,
  usePageRestored,
} from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";

const linkedSignInsQueryKey = ["settings", "linked-sign-ins"] as const;

const linkFailureMessages: Record<LinkFailure, string> = {
  // The server refuses an identity linked to any account, this one included.
  "identity-already-linked": "This sign-in is already linked to an account.",
  "link-failed": "Linking did not work. Try again.",
};

function isLinkFailure(value: string | null): value is LinkFailure {
  return linkFailures.some((failure) => failure === value);
}

const lastOneMessage = "Your last linked sign-in can't be unlinked. Link another one first.";

/** A failure worth an Alert: not the person cancelling the recent sign-in. */
function failureOf(error: Error | null): Error | null {
  return error === null || isRecentSignInCancelled(error) ? null : error;
}

/** Settings → Linked sign-ins: the accounts at sign-in providers this account signs in with. */
export function LinkedSignInsSettings() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [searchParams, setSearchParams] = useSearchParams();
  const [unlinking, setUnlinking] = useState<LinkedSignIn | null>(null);
  const query = useQuery({ queryKey: linkedSignInsQueryKey, queryFn: ({ signal }) => api("listLinkedSignIns", { signal }) });
  const providers = useQuery(signInProvidersQuery);

  const link = useMutation({
    mutationFn: (provider: SignInProvider) => run(() => api("startLink", { body: { providerId: provider.id } })),
    onMutate: (): void => unlink.reset(),
    // The provider's page is next; the button keeps spinning until the browser gets there.
    onSuccess: ({ url }) => browserNavigation.assign(url),
  });
  // Back from the provider's page (it refused, or the person changed their mind): the buttons work again.
  usePageRestored(link.reset);

  const unlink = useMutation({
    mutationFn: (linked: LinkedSignIn) => run(() => api("unlink", { params: { id: linked.id } })),
    onMutate: (): void => link.reset(),
    onSuccess: () => toast.show({ tone: "success", title: "Sign-in unlinked" }),
    onSettled: () => {
      setUnlinking(null);
      void queryClient.invalidateQueries({ queryKey: linkedSignInsQueryKey });
    },
  });

  const dismissResult = () => setSearchParams({}, { replace: true });

  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading linked sign-ins…</p>;
  if (query.isError) {
    return (
      <Alert
        tone="danger"
        title="Linked sign-ins could not be loaded"
        action={
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        {problemMessage(query.error, "Reload the page to try again.")}
      </Alert>
    );
  }

  const { linkedSignIns } = query.data;
  const available = providers.data?.providers ?? [];
  const linkedProviderId = searchParams.get("linked");
  const linkedName =
    linkedSignIns.find((linked) => linked.providerId === linkedProviderId)?.providerName ??
    available.find((provider) => provider.id === linkedProviderId)?.name;
  const linkError = searchParams.get("error");
  const failure = failureOf(link.error) ?? failureOf(unlink.error);
  const hasLastOne = linkedSignIns.some((linked) => !linked.removable);
  const busy = link.isPending || link.isSuccess;

  const columns: DataTableColumn<LinkedSignIn>[] = [
    {
      key: "provider",
      header: "Provider",
      wrap: true,
      render: (linked) => (
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{linked.providerName}</span>
            {!linked.providerEnabled && (
              <Badge tone="warning" size="sm">
                Provider turned off
              </Badge>
            )}
          </span>
          {!linked.providerEnabled && (
            <span className="type-caption text-fg-3">It can't be used to sign in until the provider is turned on again.</span>
          )}
        </span>
      ),
    },
    { key: "email", header: "Email", wrap: true, render: (linked) => linked.email ?? "Not shared" },
    { key: "createdAt", header: "Linked", render: (linked) => <time dateTime={linked.createdAt}>{formatDateTime(linked.createdAt)}</time> },
    {
      key: "lastUsedAt",
      header: "Last used",
      render: (linked) =>
        linked.lastUsedAt === null ? (
          "Never"
        ) : (
          <time dateTime={linked.lastUsedAt} title={formatDateTime(linked.lastUsedAt)}>
            {formatRelative(linked.lastUsedAt)}
          </time>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (linked) => (
        <Button
          variant="danger-ghost"
          size="sm"
          disabled={!linked.removable}
          aria-label={`Unlink ${linked.providerName}`}
          onClick={() => {
            unlink.reset();
            setUnlinking(linked);
          }}
        >
          Unlink
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {linkedProviderId !== null && (
        <Alert tone="success" onClose={dismissResult}>
          {linkedName === undefined ? "Sign-in linked." : `${linkedName} linked. You can sign in with it now.`}
        </Alert>
      )}
      {isLinkFailure(linkError) && (
        <Alert tone="danger" onClose={dismissResult}>
          {linkFailureMessages[linkError]}
        </Alert>
      )}
      {failure !== null && <Alert tone="danger">{ssoProblemMessage(failure, "That did not work. Try again.")}</Alert>}
      {providers.isError && (
        <Alert
          tone="warning"
          title="The sign-in providers could not be loaded"
          action={
            <Button variant="secondary" size="sm" onClick={() => void providers.refetch()}>
              Try again
            </Button>
          }
        >
          {problemMessage(providers.error, "You can't link a new sign-in until they load.")}
        </Alert>
      )}
      <Card
        title="Linked sign-ins"
        subtitle="Accounts at other services you can sign in with."
        padding="none"
        actions={
          available.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {available.map((provider) => (
                <Button
                  key={provider.id}
                  variant="secondary"
                  loading={busy && link.variables.id === provider.id}
                  disabled={busy}
                  onClick={() => link.mutate(provider)}
                >
                  Link {provider.name}
                </Button>
              ))}
            </div>
          ) : undefined
        }
        footer={hasLastOne ? lastOneMessage : undefined}
      >
        <DataTable
          caption="Your linked sign-ins"
          columns={columns}
          rows={[...linkedSignIns]}
          empty={<EmptyState compact title="No linked sign-ins" description="Link an account at a provider to sign in with it." />}
        />
      </Card>

      <Dialog
        open={unlinking !== null}
        onClose={() => setUnlinking(null)}
        tone="danger"
        title={unlinking === null ? undefined : `Unlink ${unlinking.providerName}?`}
        description="You can no longer sign in with this account. You can link it again later."
        actions={
          <>
            <Button variant="secondary" onClick={() => setUnlinking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={unlink.isPending}
              onClick={() => {
                if (unlinking !== null) unlink.mutate(unlinking);
              }}
            >
              Unlink
            </Button>
          </>
        }
      />
    </div>
  );
}
