import type { SsoProvider } from "@not-unreachable/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  useToast,
  type DataTableColumn,
  type MenuItem,
} from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/index.ts";
import { problemMessage, providerKindLabels, ssoProblemMessage } from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";
import { SignInProviderDrawer, ssoProvidersQueryKey, type ProviderDrawerState } from "./sign-in-provider-drawer.tsx";

/** Admin settings → Sign-in providers: the single sign-on providers people can sign in with. */
export function SignInProvidersSettings() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [drawer, setDrawer] = useState<ProviderDrawerState>(null);
  const [removing, setRemoving] = useState<SsoProvider | null>(null);
  const query = useQuery({ queryKey: ssoProvidersQueryKey, queryFn: ({ signal }) => api("listSsoProviders", { signal }) });

  const remove = useMutation({
    mutationFn: (provider: SsoProvider) => run(() => api("removeSsoProvider", { params: { id: provider.id } })),
    onSuccess: () => {
      setRemoving(null);
      toast.show({ tone: "success", title: "Provider removed" });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ssoProvidersQueryKey }),
  });

  const openRemove = (provider: SsoProvider) => {
    remove.reset();
    setRemoving(provider);
  };

  const actionsOf = (provider: SsoProvider): MenuItem[] => [
    { label: "Edit", icon: <Icon name="pencil" size={14} />, onSelect: () => setDrawer({ mode: "edit", provider }) },
    { divider: true },
    provider.linkedSignIns > 0
      ? { label: "In use: turn it off instead of removing", icon: <Icon name="trash-2" size={14} />, disabled: true }
      : { label: "Remove", icon: <Icon name="trash-2" size={14} />, danger: true, onSelect: () => openRemove(provider) },
  ];

  const columns: DataTableColumn<SsoProvider>[] = [
    { key: "name", header: "Name", wrap: true, render: (provider) => <span className="font-medium">{provider.name}</span> },
    { key: "kind", header: "Kind", render: (provider) => providerKindLabels[provider.kind] },
    {
      key: "enabled",
      header: "Status",
      render: (provider) =>
        provider.enabled ? (
          <Badge tone="success" dot>
            On
          </Badge>
        ) : (
          <Badge tone="neutral" dot>
            Off
          </Badge>
        ),
    },
    { key: "linkedSignIns", header: "Linked sign-ins", align: "right", render: (provider) => provider.linkedSignIns },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (provider) => (
        <Menu
          width={300}
          trigger={<IconButton label={`Actions for ${provider.name}`} size="sm" icon={<Icon name="more-horizontal" size={16} />} />}
          items={actionsOf(provider)}
        />
      ),
    },
  ];

  const addProvider = (
    // A new provider's redirect URI needs the public origin the list reports.
    <Button
      variant="secondary"
      iconLeft={<Icon name="plus" size={14} />}
      disabled={query.data === undefined}
      onClick={() => setDrawer({ mode: "add" })}
    >
      Add provider
    </Button>
  );

  return (
    <>
      <Card
        title="Sign-in providers"
        subtitle="Services people can sign in with instead of a password."
        padding="none"
        actions={addProvider}
      >
        {query.isPending ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading sign-in providers…</p>
        ) : query.isError ? (
          <div className="p-5">
            <Alert
              tone="danger"
              title="Sign-in providers could not be loaded"
              action={
                <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
                  Try again
                </Button>
              }
            >
              {problemMessage(query.error, "Reload the page to try again.")}
            </Alert>
          </div>
        ) : (
          <DataTable
            caption="Sign-in providers"
            columns={columns}
            rows={query.data.providers}
            empty={
              <EmptyState
                compact
                icon="log-in"
                title="No sign-in providers yet"
                description="Add Google, GitHub or another OpenID Connect provider to let people sign in with it."
              />
            }
          />
        )}
      </Card>

      {query.data !== undefined && <SignInProviderDrawer state={drawer} publicOrigin={query.data.publicOrigin} onChange={setDrawer} />}

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="danger"
        title={removing === null ? undefined : `Remove ${removing.name}?`}
        description="Nobody can sign in with it any more. To use it again, add it again."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (removing !== null) remove.mutate(removing);
              }}
            >
              Remove provider
            </Button>
          </>
        }
      >
        {remove.isError && !isRecentSignInCancelled(remove.error) ? (
          <Alert tone="danger">{ssoProblemMessage(remove.error, "Removing the provider did not work. Try again.")}</Alert>
        ) : null}
      </Dialog>
    </>
  );
}
