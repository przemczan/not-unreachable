import type { SharedWithMeLink } from "@not-unreachable/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Icon,
  PageHeader,
  Pagination,
  type DataTableColumn,
} from "@not-unreachable/design-system";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/index.ts";
import { AccountShell } from "../layout/index.ts";
import { formatDateTime, formatShortDateTime, iconOf, problemMessage } from "../lib/index.ts";
import { RequireAccount } from "../session/index.ts";

export const SHARED_WITH_ME_PAGE_SIZE = 50;

const sharedWithMeQueryKey = ["shared-with-me"] as const;

const kindLabels: Record<SharedWithMeLink["kind"], string> = { file: "File", folder: "Folder" };

function ExpiryBadge({ expiresAt }: { readonly expiresAt: string | null }) {
  if (expiresAt === null) return <Badge tone="neutral">No expiry</Badge>;
  return (
    <span title={formatDateTime(expiresAt)}>
      <Badge tone="success" dot>
        Expires {formatShortDateTime(expiresAt)}
      </Badge>
    </span>
  );
}

const columns: DataTableColumn<SharedWithMeLink>[] = [
  {
    key: "item",
    header: "Item",
    wrap: true,
    // A plain link: the share page loads afresh and applies the link's access, password and limits.
    render: (shareLink) => (
      <a href={shareLink.link} className="flex min-w-0 items-center gap-2.5 text-fg-1 no-underline hover:underline">
        <span className={shareLink.kind === "folder" ? "grid text-accent" : "grid text-fg-3"}>
          <Icon name={iconOf(shareLink.kind, shareLink.name)} size={16} />
        </span>
        <span className="truncate font-medium">{shareLink.name}</span>
      </a>
    ),
  },
  { key: "kind", header: "Kind", width: 110, muted: true, render: (shareLink) => kindLabels[shareLink.kind] },
  { key: "expiry", header: "Expiry", render: (shareLink) => <ExpiryBadge expiresAt={shareLink.expiresAt} /> },
  {
    key: "password",
    header: "Password",
    render: (shareLink) => (shareLink.hasPassword ? <Badge tone="info">Password</Badge> : <span className="text-fg-3">None</span>),
  },
];

/** Shared with me: the share links the user can open, newest first. */
function SharedWithMe() {
  /** The cursor of each page after the first that was opened, in order. */
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.at(-1);

  const page = useQuery({
    queryKey: [...sharedWithMeQueryKey, cursor ?? null],
    queryFn: ({ signal }) =>
      api("listSharedWithMe", {
        query: { limit: SHARED_WITH_ME_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal,
      }),
    placeholderData: keepPreviousData,
  });

  const links = page.data?.shareLinks ?? [];

  return (
    <>
      <PageHeader title="Shared with me" description="Files and folders shared with you. Open one to see it on its share page." />

      <Card padding="none">
        {page.isPending ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading shared items…</p>
        ) : page.isError ? (
          <div className="p-5">
            <Alert
              tone="danger"
              title="Shared items could not be loaded"
              action={
                <Button variant="secondary" size="sm" onClick={() => void page.refetch()}>
                  Try again
                </Button>
              }
            >
              {problemMessage(page.error, "Reload the page to try again.")}
            </Alert>
          </div>
        ) : (
          <DataTable
            caption="Shared with me"
            columns={columns}
            rows={links}
            empty={
              <EmptyState
                icon="share-2"
                title="Nothing is shared with you yet."
                description="When a file or folder is shared with you, it shows up here."
              />
            }
          />
        )}
      </Card>

      {page.data !== undefined && (cursors.length > 0 || page.data.nextCursor !== null) && (
        <Pagination
          aria-label="Shared with me pages"
          loading={page.isFetching}
          hasPrevious={cursors.length > 0}
          hasNext={page.data.nextCursor !== null}
          onPrevious={() => setCursors(cursors.slice(0, -1))}
          onNext={() => {
            const next = page.data.nextCursor;
            if (next !== null) setCursors([...cursors, next]);
          }}
          summary={`Page ${cursors.length + 1} · ${links.length} ${links.length === 1 ? "item" : "items"}`}
        />
      )}
    </>
  );
}

/** A user's Shared with me; the admin manages every link in Share links instead. */
export function Component() {
  return (
    <RequireAccount requiredRole="user">
      <AccountShell activeId="shared">
        <SharedWithMe />
      </AccountShell>
    </RequireAccount>
  );
}
