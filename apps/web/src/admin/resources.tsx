import { problemTypes, type Resource } from "@not-unreachable/contracts";
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
  PageHeader,
  useToast,
  type DataTableColumn,
  type MenuItem,
} from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/index.ts";
import { isProblem, problemMessage } from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";
import { HomeRootCard } from "./home-root.tsx";
import { ResourceDrawer, resourcesQueryKey, type ResourceDrawerState } from "./resource-drawer.tsx";
import {
  isUnencryptedShare,
  resourceKindLabels,
  resourceLocationOf,
  UNENCRYPTED_WARNING,
  unavailableReasonLabels,
} from "./resource-wording.tsx";

/** Why the server kept a resource it was asked to remove. */
function removeErrorOf(error: unknown): string {
  if (isProblem(error, problemTypes.homeRootResource)) {
    return error.problem.reason === "holds-homes"
      ? "Users' homes are in this resource, so it can't be removed."
      : "This resource holds the home root. Choose another home root first.";
  }
  return problemMessage(error, "Removing the resource did not work. Try again.");
}

function removedDescriptionOf(resource: Resource): string {
  return resource.kind === "smb" ? "Its folders and files stay on the share." : "Its folder and files stay on the server.";
}

/** A local folder's path or a share's address, with the warning for a share that isn't encrypted. */
function LocationCell({ resource }: { readonly resource: Resource }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="type-mono wrap-anywhere">{resourceLocationOf(resource)}</span>
      {isUnencryptedShare(resource) && (
        <span className="flex items-center gap-1.5 type-body-sm text-warning-fg">
          <Icon name="triangle-alert" size={14} />
          {UNENCRYPTED_WARNING}
        </span>
      )}
    </span>
  );
}

function StatusCell({ resource }: { readonly resource: Resource }) {
  if (resource.state === "available") {
    return (
      <Badge tone="success" dot>
        Available
      </Badge>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone="danger" dot>
        Unavailable
      </Badge>
      <span className="type-body-sm text-fg-2">{unavailableReasonLabels[resource.unavailableReason ?? "missing"]}</span>
    </span>
  );
}

export function ResourcesPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [drawer, setDrawer] = useState<ResourceDrawerState>(null);
  const [removing, setRemoving] = useState<Resource | null>(null);
  const query = useQuery({ queryKey: resourcesQueryKey, queryFn: ({ signal }) => api("listResources", { signal }) });

  const retry = useMutation({
    mutationFn: (resource: Resource) => api("retryResource", { params: { id: resource.id } }),
    onSuccess: (resource) => {
      if (resource.state === "available") {
        toast.show({ tone: "success", title: "Resource available", description: `${resource.name} can be used again.` });
      } else {
        toast.show({
          tone: "warning",
          title: "Resource still unavailable",
          description: unavailableReasonLabels[resource.unavailableReason ?? "missing"],
        });
      }
    },
    onError: (error) => toast.show({ tone: "danger", title: "Retry did not work", description: problemMessage(error, "Try again.") }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: resourcesQueryKey }),
  });

  const remove = useMutation({
    mutationFn: (resource: Resource) => run(() => api("removeResource", { params: { id: resource.id } })),
    onSuccess: (_, resource) => {
      setRemoving(null);
      toast.show({ tone: "success", title: "Resource removed", description: removedDescriptionOf(resource) });
      void queryClient.invalidateQueries({ queryKey: resourcesQueryKey });
    },
  });

  const openRemove = (resource: Resource) => {
    remove.reset();
    setRemoving(resource);
  };

  const actionsOf = (resource: Resource): MenuItem[] => [
    { label: "Edit", icon: <Icon name="pencil" size={14} />, onSelect: () => setDrawer({ mode: "edit", resource }) },
    ...(resource.state === "unavailable"
      ? [{ label: "Retry", icon: <Icon name="refresh-cw" size={14} />, onSelect: () => retry.mutate(resource) }]
      : []),
    { divider: true },
    resource.isHomeRoot
      ? { label: "Holds the home root: can't be removed", icon: <Icon name="trash-2" size={14} />, disabled: true }
      : { label: "Remove", icon: <Icon name="trash-2" size={14} />, danger: true, onSelect: () => openRemove(resource) },
  ];

  const columns: DataTableColumn<Resource>[] = [
    {
      key: "name",
      header: "Name",
      wrap: true,
      render: (resource) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{resource.name}</span>
          {resource.isHomeRoot && (
            <Badge tone="accent" size="sm">
              Home root
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "location",
      header: "Location",
      wrap: true,
      render: (resource) => <LocationCell resource={resource} />,
    },
    { key: "status", header: "Status", wrap: true, render: (resource) => <StatusCell resource={resource} /> },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (resource) => (
        <Menu
          width={280}
          trigger={<IconButton label={`Actions for ${resource.name}`} size="sm" icon={<Icon name="more-horizontal" size={16} />} />}
          items={actionsOf(resource)}
        />
      ),
    },
  ];

  const addResource = (
    <Menu
      align="end"
      width={220}
      trigger={
        <Button iconLeft={<Icon name="plus" size={14} />} iconRight={<Icon name="chevron-down" size={14} />}>
          Add resource
        </Button>
      }
      items={[
        {
          label: resourceKindLabels.local,
          icon: <Icon name="folder" size={14} />,
          onSelect: () => setDrawer({ mode: "add", kind: "local" }),
        },
        {
          label: resourceKindLabels.smb,
          icon: <Icon name="hard-drive" size={14} />,
          onSelect: () => setDrawer({ mode: "add", kind: "smb" }),
        },
      ]}
    />
  );

  return (
    <>
      <PageHeader
        title="Resources"
        description="The folders on the server and the network shares that hold users' files and homes."
        actions={addResource}
      />

      <Card padding="none">
        {query.isPending ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading resources…</p>
        ) : query.isError ? (
          <div className="p-5">
            <Alert
              tone="danger"
              title="Resources could not be loaded"
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
            caption="Resources"
            columns={columns}
            rows={query.data.resources}
            empty={
              <EmptyState
                icon="hard-drive"
                title="No resources yet"
                description="Add a folder on the server or an SMB share for NotUnreachable to keep users' files in."
                action={addResource}
              />
            }
          />
        )}
      </Card>

      {query.data !== undefined && <HomeRootCard resources={query.data.resources} homeRoot={query.data.homeRoot} />}

      <ResourceDrawer state={drawer} onClose={() => setDrawer(null)} />

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="danger"
        title={removing === null ? undefined : `Remove ${removing.name}?`}
        description={
          removing?.kind === "smb"
            ? "NotUnreachable unmounts the share and stops using it. Nothing on the share is deleted: its folders and files stay where they are."
            : "NotUnreachable stops using this resource. Nothing on disk is deleted: the folder and its files stay on the server."
        }
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
              Remove resource
            </Button>
          </>
        }
      >
        {remove.isError && !isRecentSignInCancelled(remove.error) ? <Alert tone="danger">{removeErrorOf(remove.error)}</Alert> : null}
      </Dialog>
    </>
  );
}
