import type { Entry } from "@not-unreachable/contracts";
import { Alert, Button, Card, EmptyState, PageHeader, Select } from "@not-unreachable/design-system";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api/index.ts";
import { FileBrowser, folderHref, resourceSource, uploadStoreFor, type EntryButton } from "../files/index.ts";
import { problemMessage } from "../lib/index.ts";
import { useSignedInSession } from "../session/index.ts";
import { resourcesQueryKey } from "./resource-drawer.tsx";
import { shareAddressOf } from "./resource-wording.tsx";
import { ShareLinkDialog, type ShareTarget } from "./share-link-dialogs.tsx";

/** `/admin/files` and `/admin/files/:resourceId`: the files of every available resource. */
export function AdminFilesPage() {
  const { resourceId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { account } = useSignedInSession();
  const resources = useQuery({ queryKey: resourcesQueryKey, queryFn: ({ signal }) => api("listResources", { signal }) });
  const source = useMemo(() => (resourceId === undefined ? undefined : resourceSource(resourceId)), [resourceId]);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);

  if (resources.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading resources…</p>;
  if (resources.isError) {
    return (
      <>
        <PageHeader title="Files" />
        <Alert
          tone="danger"
          title="Resources could not be loaded"
          action={
            <Button variant="secondary" size="sm" onClick={() => void resources.refetch()}>
              Try again
            </Button>
          }
        >
          {problemMessage(resources.error, "Reload the page to try again.")}
        </Alert>
      </>
    );
  }

  const available = resources.data.resources.filter((resource) => resource.state === "available");
  const current = resources.data.resources.find((resource) => resource.id === resourceId);

  if (resourceId === undefined || source === undefined) {
    const [first] = available;
    if (first !== undefined) return <Navigate replace to={`/admin/files/${first.id}`} />;
    return (
      <>
        <PageHeader title="Files" description="The files in the resources on the server." />
        <Card padding="none">
          <EmptyState
            icon="hard-drive"
            title="No resources to browse"
            description="Add a folder on the Resources page, or make an unavailable one available again."
            action={<Button onClick={() => void navigate("/admin/resources")}>Go to Resources</Button>}
          />
        </Card>
      </>
    );
  }

  if (current === undefined || current.state !== "available") {
    return (
      <>
        <PageHeader title="Files" />
        <Alert
          tone="warning"
          title={current === undefined ? "This resource doesn't exist" : `${current.name} is unavailable`}
          action={
            <Button variant="secondary" size="sm" onClick={() => void navigate("/admin/files")}>
              Browse another resource
            </Button>
          }
        >
          {current === undefined ? "It may have been removed." : "Retry it on the Resources page to browse its files."}
        </Alert>
      </>
    );
  }

  const page = `/admin/files/${current.id}`;
  const currentId = current.id;
  const shareButton = (entry: Entry, entryPath: string): EntryButton[] => {
    const { kind, name } = entry;
    if (kind !== "file" && kind !== "folder") return [];
    return [{ label: `Share ${name}`, icon: "share-2", onClick: () => setSharing({ resourceId: currentId, path: entryPath, name, kind }) }];
  };
  return (
    <>
      <FileBrowser
        source={source}
        path={search.get("path") ?? ""}
        hrefOf={(path) => folderHref(page, path)}
        rootLabel={current.name}
        title="Files"
        description={
          current.kind === "smb"
            ? `The files in ${current.name}, on the share ${shareAddressOf(current)}.`
            : `The files in ${current.name}, on the server at ${current.localPath}.`
        }
        uploads={uploadStoreFor(account.id)}
        aside={
          available.length > 1 ? (
            <Select
              aria-label="Resource"
              className="w-48"
              value={current.id}
              options={available.map((resource) => ({ value: resource.id, label: resource.name }))}
              onChange={(value) => void navigate(`/admin/files/${value}`)}
            />
          ) : undefined
        }
        entryButtons={shareButton}
      />
      {sharing !== null && <ShareLinkDialog target={sharing} onClose={() => setSharing(null)} />}
    </>
  );
}
