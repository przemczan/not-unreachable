import { shareLinkStates, type ShareLink, type ShareLinkState } from "@not-unreachable/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  PageHeader,
  Pagination,
  Tag,
  useToast,
  type DataTableColumn,
  type MenuItem,
} from "@not-unreachable/design-system";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/index.ts";
import { formatDateTime, formatRelative, formatShortDateTime, iconOf, problemMessage } from "../lib/index.ts";
import { CopyShareLinkDialog, RevokeShareLinkDialog, ShareLinkDialog, shareLinksQueryKey } from "./share-link-dialogs.tsx";

export const SHARE_LINKS_PAGE_SIZE = 50;

const stateLabels: Record<ShareLinkState, string> = { active: "Active", expired: "Expired", revoked: "Revoked" };

const count = new Intl.NumberFormat();

/** The expiry Badge: Revoked, Expired, No expiry (marked, as T8 asks), or when it expires. */
function ExpiryBadge({ shareLink }: { readonly shareLink: ShareLink }) {
  if (shareLink.state === "revoked") return <Badge tone="neutral">Revoked</Badge>;
  if (shareLink.state === "expired") return <Badge tone="neutral">Expired</Badge>;
  if (shareLink.expiresAt === null) {
    return (
      <Badge tone="warning" dot>
        No expiry
      </Badge>
    );
  }
  return (
    <span title={formatRelative(shareLink.expiresAt)}>
      <Badge tone="success" dot>
        Expires {formatShortDateTime(shareLink.expiresAt)}
      </Badge>
    </span>
  );
}

/** Who can open a link: anyone (no Badge), signed-in users, or how many users were picked, named in its title. */
function AccessBadge({ shareLink }: { readonly shareLink: ShareLink }) {
  if (shareLink.access === "anyone") return <span className="text-fg-3">Anyone with the link</span>;
  if (shareLink.access === "signed-in") return <Badge tone="info">Signed-in users</Badge>;
  const users = shareLink.allowedUsers;
  if (users.length === 0) {
    return (
      <span title="Every user it was shared with was removed">
        <Badge tone="neutral">Only you</Badge>
      </span>
    );
  }
  return (
    <span title={users.map((user) => user.username).join(", ")}>
      <Badge tone="info">{users.length === 1 ? "1 user" : `${count.format(users.length)} users`}</Badge>
    </span>
  );
}

interface CursorStack {
  /** The filter the cursors belong to: another filter starts again at the first page. */
  readonly state: ShareLinkState | null;
  /** The cursor of each page after the first that was opened, in order. */
  readonly cursors: readonly string[];
}

type OpenAction =
  | { readonly kind: "edit" | "revoke"; readonly shareLink: ShareLink }
  | { readonly kind: "copy"; readonly name: string; readonly link: string };

/** Admin → Share links: every link made, newest first, with its expiry, who can open it, its password and use. */
export function ShareLinksPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<ShareLinkState | null>(null);
  const [stack, setStack] = useState<CursorStack>({ state, cursors: [] });
  const cursors = stack.state === state ? stack.cursors : [];
  const cursor = cursors.at(-1);
  const [open, setOpen] = useState<OpenAction | null>(null);
  const close = () => setOpen(null);

  const page = useQuery({
    queryKey: [...shareLinksQueryKey, state, cursor ?? null],
    queryFn: ({ signal }) =>
      api("listShareLinks", {
        query: { limit: SHARE_LINKS_PAGE_SIZE, ...(state === null ? {} : { state }), ...(cursor === undefined ? {} : { cursor }) },
        signal,
      }),
    placeholderData: keepPreviousData,
  });

  /** The list never holds a link's URL: it is read for the one link, then copied. */
  const copyLink = async (shareLink: ShareLink) => {
    let link: string;
    try {
      ({ link } = await queryClient.fetchQuery({
        queryKey: [...shareLinksQueryKey, "detail", shareLink.id],
        queryFn: ({ signal }) => api("getShareLink", { params: { id: shareLink.id }, signal }),
      }));
    } catch (error) {
      toast.show({ tone: "danger", title: "The link could not be loaded", description: problemMessage(error, "Try again.") });
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      toast.show({ tone: "success", title: "Link copied" });
    } catch {
      setOpen({ kind: "copy", name: shareLink.name, link });
    }
  };

  const actionsOf = (shareLink: ShareLink): MenuItem[] => {
    const revoked = shareLink.state === "revoked";
    return [
      { label: "Copy link", icon: <Icon name="copy" size={14} />, disabled: revoked, onSelect: () => void copyLink(shareLink) },
      { label: "Edit", icon: <Icon name="pencil" size={14} />, disabled: revoked, onSelect: () => setOpen({ kind: "edit", shareLink }) },
      { divider: true },
      {
        label: "Revoke",
        icon: <Icon name="x" size={14} />,
        danger: true,
        disabled: revoked,
        onSelect: () => setOpen({ kind: "revoke", shareLink }),
      },
    ];
  };

  const columns: DataTableColumn<ShareLink>[] = [
    {
      key: "item",
      header: "Item",
      wrap: true,
      render: (shareLink) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span className={shareLink.kind === "folder" ? "grid text-accent" : "grid text-fg-3"}>
            <Icon name={iconOf(shareLink.kind, shareLink.name)} size={16} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{shareLink.name}</span>
            <span className="truncate type-body-sm text-fg-3">
              {shareLink.resourceName} / {shareLink.path}
            </span>
          </span>
        </span>
      ),
    },
    { key: "expiry", header: "Expiry", render: (shareLink) => <ExpiryBadge shareLink={shareLink} /> },
    { key: "access", header: "Who can open it", render: (shareLink) => <AccessBadge shareLink={shareLink} /> },
    {
      key: "password",
      header: "Password",
      render: (shareLink) =>
        shareLink.hasPassword || shareLink.locked ? (
          <span className="flex items-center gap-1.5">
            {shareLink.hasPassword && <Badge tone="info">Password</Badge>}
            {shareLink.locked && (
              <span title={shareLink.lockedUntil === null ? undefined : `Until ${formatDateTime(shareLink.lockedUntil)}`}>
                <Badge tone="danger">Locked</Badge>
              </span>
            )}
          </span>
        ) : (
          <span className="text-fg-3">None</span>
        ),
    },
    {
      key: "downloads",
      header: "Downloads",
      align: "right",
      width: 110,
      render: (shareLink) => <span className="tabular-nums">{count.format(shareLink.downloadCount)}</span>,
    },
    {
      key: "lastUsed",
      header: "Last used",
      width: 140,
      muted: true,
      render: (shareLink) =>
        shareLink.lastUsedAt === null ? (
          "—"
        ) : (
          <time dateTime={shareLink.lastUsedAt} title={formatDateTime(shareLink.lastUsedAt)}>
            {formatRelative(shareLink.lastUsedAt)}
          </time>
        ),
    },
    {
      key: "created",
      header: "Created",
      width: 140,
      muted: true,
      render: (shareLink) => (
        <time dateTime={shareLink.createdAt} title={formatDateTime(shareLink.createdAt)}>
          {formatRelative(shareLink.createdAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: 64,
      render: (shareLink) => (
        <Menu
          trigger={<IconButton label={`Actions for ${shareLink.name}`} size="sm" icon={<Icon name="more-horizontal" size={16} />} />}
          items={actionsOf(shareLink)}
        />
      ),
    },
  ];

  const links = page.data?.shareLinks ?? [];

  return (
    <>
      <PageHeader
        title="Share links"
        description="The links you made to files and folders. Make one with a file's Share link button in Files."
      />

      <fieldset aria-label="State" className="m-0 flex h-8 items-center gap-1.5 border-0 p-0">
        {shareLinkStates.map((option) => (
          <Tag key={option} selected={state === option} onClick={() => setState(state === option ? null : option)}>
            {stateLabels[option]}
          </Tag>
        ))}
      </fieldset>

      <Card padding="none">
        {page.isPending ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading share links…</p>
        ) : page.isError ? (
          <div className="p-5">
            <Alert
              tone="danger"
              title="Share links could not be loaded"
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
            caption="Share links"
            columns={columns}
            rows={links}
            empty={
              <EmptyState
                icon="share-2"
                title={state === null ? "No share links yet" : `No ${stateLabels[state].toLowerCase()} links`}
                description={
                  state === null
                    ? "Share a file or folder with its Share link button in Files, and the link shows up here."
                    : "Try another filter, or clear it to see every link."
                }
              />
            }
          />
        )}
      </Card>

      {page.data !== undefined && (cursors.length > 0 || page.data.nextCursor !== null) && (
        <Pagination
          aria-label="Share links pages"
          loading={page.isFetching}
          hasPrevious={cursors.length > 0}
          hasNext={page.data.nextCursor !== null}
          onPrevious={() => setStack({ state, cursors: cursors.slice(0, -1) })}
          onNext={() => {
            const next = page.data.nextCursor;
            if (next !== null) setStack({ state, cursors: [...cursors, next] });
          }}
          summary={`Page ${cursors.length + 1} · ${links.length} ${links.length === 1 ? "link" : "links"}`}
        />
      )}

      {open?.kind === "edit" && <ShareLinkDialog shareLink={open.shareLink} onClose={close} />}
      {open?.kind === "revoke" && <RevokeShareLinkDialog shareLink={open.shareLink} onClose={close} />}
      {open?.kind === "copy" && <CopyShareLinkDialog name={open.name} link={open.link} onClose={close} />}
    </>
  );
}
