import type { Entry } from "@not-unreachable/contracts";
import { Alert, Button, ButtonLink, Card, EmptyState, Icon, PageHeader } from "@not-unreachable/design-system";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, api } from "../api/index.ts";
import { FileBrowser, folderHref, joinPath, uploadStoreFor, userHomeSource, type EntryButton } from "../files/index.ts";
import { problemMessage } from "../lib/index.ts";
import { useSignedInSession } from "../session/index.ts";
import { resourcesQueryKey } from "./resource-drawer.tsx";
import { ShareLinkDialog, type ShareTarget } from "./share-link-dialogs.tsx";
import { usersQueryKey } from "./user-dialogs.tsx";

/** The page of a user's home files. */
export function userFilesHref(userId: string): string {
  return `/admin/users/${userId}/files`;
}

const backToUsers = (
  <ButtonLink variant="secondary" href="/admin/users" iconLeft={<Icon name="arrow-left" size={14} />}>
    Back to Users
  </ButtonLink>
);

/** `/admin/users/:userId/files`: the admin browses and manages one user's home. */
export function UserFilesPage() {
  const { userId = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { account } = useSignedInSession();
  const user = useQuery({
    queryKey: [...usersQueryKey, userId],
    queryFn: ({ signal }) => api("getUser", { params: { id: userId }, signal }),
  });
  const resources = useQuery({ queryKey: resourcesQueryKey, queryFn: ({ signal }) => api("listResources", { signal }) });
  const home = user.data?.home ?? null;
  const source = useMemo(() => (home === null ? undefined : userHomeSource(home)), [home]);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);

  if (user.isError && user.error instanceof ApiError && user.error.status === 404) {
    return (
      <>
        <PageHeader title="Files" />
        <Alert
          tone="warning"
          title="This user doesn't exist"
          action={
            <Button variant="secondary" size="sm" onClick={() => void navigate("/admin/users")}>
              Go to Users
            </Button>
          }
        >
          They may have been removed.
        </Alert>
      </>
    );
  }
  if (user.isError || resources.isError) {
    const failed = user.isError ? user : resources;
    return (
      <>
        <PageHeader title="Files" />
        <Alert
          tone="danger"
          title={user.isError ? "The user could not be loaded" : "Resources could not be loaded"}
          action={
            <Button variant="secondary" size="sm" onClick={() => void failed.refetch()}>
              Try again
            </Button>
          }
        >
          {problemMessage(failed.error, "Reload the page to try again.")}
        </Alert>
      </>
    );
  }
  if (user.isPending || resources.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading files…</p>;

  const { displayName, username } = user.data;
  const title = `Files of ${displayName}`;

  if (home === null || source === undefined) {
    return (
      <>
        <PageHeader title={title} actions={backToUsers} />
        <Card padding="none">
          <EmptyState
            icon="folder"
            title="No home folder"
            description={`No home folder is recorded for ${username}, so there are no files to browse.`}
          />
        </Card>
      </>
    );
  }

  const resource = resources.data.resources.find((candidate) => candidate.id === home.resourceId);
  if (resource === undefined || resource.state !== "available") {
    return (
      <>
        <PageHeader title={title} actions={backToUsers} />
        <Alert
          tone="warning"
          title={resource === undefined ? "The resource of this home doesn't exist" : `${resource.name} is unavailable`}
          action={
            <Button variant="secondary" size="sm" onClick={() => void navigate("/admin/resources")}>
              Go to Resources
            </Button>
          }
        >
          {resource === undefined
            ? "It may have been removed."
            : `${username}'s home is on ${resource.name}. Retry it on the Resources page to browse its files.`}
        </Alert>
      </>
    );
  }

  const page = userFilesHref(user.data.id);
  // Share links point into the resource: the home's folder, then the entry's path within it.
  const shareButton = (entry: Entry, entryPath: string): EntryButton[] => {
    const { kind, name } = entry;
    if (kind !== "file" && kind !== "folder") return [];
    const path = joinPath(home.path, entryPath);
    return [{ label: `Share ${name}`, icon: "share-2", onClick: () => setSharing({ resourceId: home.resourceId, path, name, kind }) }];
  };
  return (
    <>
      <FileBrowser
        source={source}
        path={search.get("path") ?? ""}
        hrefOf={(path) => folderHref(page, path)}
        rootLabel={displayName}
        title={title}
        description={`The home folder of ${username}, in ${resource.name}.`}
        uploads={uploadStoreFor(account.id)}
        aside={backToUsers}
        entryButtons={shareButton}
      />
      {sharing !== null && <ShareLinkDialog target={sharing} onClose={() => setSharing(null)} />}
    </>
  );
}
