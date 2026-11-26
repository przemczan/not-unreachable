import type { User, Users } from "@not-unreachable/contracts";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Icon,
  IconButton,
  IconButtonLink,
  Input,
  Menu,
  PageHeader,
  Tabs,
  Tooltip,
  useToast,
  type DataTableColumn,
  type MenuItem,
  type TabItem,
} from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type * as React from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { api } from "../api/index.ts";
import { renderRouterLink } from "../layout/index.ts";
import { errorProp, formatBytes, formatDateTime, problemMessage } from "../lib/index.ts";
import { InvitationsTab, InviteDialog } from "./invitations.tsx";
import {
  DisableUserDialog,
  QuotaDialog,
  RelinkLinkDialog,
  RemoveUserDialog,
  UnlinkSignInDialog,
  bytesToGbText,
  gbToBytes,
  quotaInvalidMessage,
  usersQueryKey,
} from "./user-dialogs.tsx";
import { userFilesHref } from "./user-files.tsx";

const tabs: TabItem[] = [
  { value: "users", label: "Users", href: "/admin/users" },
  { value: "invitations", label: "Invitations", href: "/admin/users/invitations" },
];

/** Admin → Users: the users, and the invitations that bring new ones in. */
export function UsersPage() {
  const { pathname } = useLocation();
  const [inviting, setInviting] = useState(false);
  const current = pathname.startsWith("/admin/users/invitations") ? "invitations" : "users";
  const openInvite = () => setInviting(true);

  return (
    <>
      <PageHeader
        title="Users"
        description="The people who use NotUnreachable, and the invitations that let new ones in."
        actions={
          <Button iconLeft={<Icon name="user-plus" size={14} />} onClick={openInvite}>
            Invite user
          </Button>
        }
      >
        <Tabs aria-label="Users sections" tabs={tabs} renderLink={renderRouterLink} value={current} />
      </PageHeader>
      <Routes>
        <Route index element={<UsersTab onInvite={openInvite} />} />
        <Route path="invitations" element={<InvitationsTab onInvite={openInvite} />} />
        <Route path="*" element={<Navigate replace to="/admin/users" />} />
      </Routes>
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </>
  );
}

type UserAction = "status" | "quota" | "unlink" | "relink" | "remove";

interface OpenAction {
  readonly kind: UserAction;
  readonly user: User;
}

interface UsersTabProps {
  readonly onInvite: () => void;
}

function UsersTab({ onInvite }: UsersTabProps) {
  const [open, setOpen] = useState<OpenAction | null>(null);
  const query = useQuery({ queryKey: usersQueryKey, queryFn: ({ signal }) => api("listUsers", { signal }) });
  const close = () => setOpen(null);

  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading users…</p>;
  if (query.isError) {
    return (
      <Alert
        tone="danger"
        title="Users could not be loaded"
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

  const { users, defaultQuotaBytes } = query.data;

  const actionsOf = (user: User): MenuItem[] => [
    { label: "Set quota", icon: <Icon name="hard-drive" size={14} />, onSelect: () => setOpen({ kind: "quota", user }) },
    user.linkedSignIns.length > 1
      ? { label: "Unlink sign-in", icon: <Icon name="link" size={14} />, onSelect: () => setOpen({ kind: "unlink", user }) }
      : { label: "Only one sign-in: send a re-link link instead", icon: <Icon name="link" size={14} />, disabled: true },
    { label: "Send re-link link", icon: <Icon name="key-round" size={14} />, onSelect: () => setOpen({ kind: "relink", user }) },
    { divider: true },
    user.status === "active"
      ? { label: "Disable", icon: <Icon name="lock" size={14} />, onSelect: () => setOpen({ kind: "status", user }) }
      : { label: "Enable", icon: <Icon name="circle-check" size={14} />, onSelect: () => setOpen({ kind: "status", user }) },
    { label: "Remove", icon: <Icon name="trash-2" size={14} />, danger: true, onSelect: () => setOpen({ kind: "remove", user }) },
  ];

  const columns: DataTableColumn<User>[] = [
    {
      key: "user",
      header: "User",
      wrap: true,
      render: (user) => (
        <span className="flex items-center gap-3">
          <Avatar name={user.displayName} size="sm" />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{user.displayName}</span>
            <span className="type-body-sm text-fg-3">{user.username}</span>
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (user) =>
        user.status === "active" ? (
          <Badge tone="success" dot>
            Active
          </Badge>
        ) : (
          <Badge tone="neutral" dot>
            Disabled
          </Badge>
        ),
    },
    {
      key: "linkedSignIns",
      header: "Linked sign-ins",
      wrap: true,
      render: (user) =>
        user.linkedSignIns.length === 0 ? (
          <span className="text-fg-3">None</span>
        ) : (
          user.linkedSignIns.map((linked) => linked.providerName).join(", ")
        ),
    },
    {
      key: "quota",
      header: "Quota",
      render: (user) =>
        user.quotaBytes === null ? (
          <span className="text-fg-2">Default ({formatBytes(defaultQuotaBytes)})</span>
        ) : (
          formatBytes(user.quotaBytes)
        ),
    },
    {
      key: "createdAt",
      header: "Created",
      render: (user) => <time dateTime={user.createdAt}>{formatDateTime(user.createdAt)}</time>,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (user) => (
        <span className="inline-flex items-center gap-1">
          <BrowseFilesButton user={user} />
          <Menu
            width={300}
            trigger={<IconButton label={`Actions for ${user.displayName}`} size="sm" icon={<Icon name="more-horizontal" size={16} />} />}
            items={actionsOf(user)}
          />
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card padding="none">
        <DataTable
          caption="Users"
          columns={columns}
          rows={users}
          empty={
            <EmptyState
              icon="users"
              title="No users yet"
              description="Invite someone to give them an account and a home of their own."
              action={
                <Button iconLeft={<Icon name="user-plus" size={14} />} onClick={onInvite}>
                  Invite user
                </Button>
              }
            />
          }
        />
      </Card>

      <DefaultQuotaCard defaultQuotaBytes={defaultQuotaBytes} />

      {open?.kind === "status" && <DisableUserDialog user={open.user} onClose={close} />}
      {open?.kind === "quota" && <QuotaDialog user={open.user} defaultQuotaBytes={defaultQuotaBytes} onClose={close} />}
      {open?.kind === "unlink" && <UnlinkSignInDialog user={open.user} onClose={close} />}
      {open?.kind === "relink" && <RelinkLinkDialog user={open.user} onClose={close} />}
      {open?.kind === "remove" && <RemoveUserDialog user={open.user} onClose={close} />}
    </div>
  );
}

/** A row's link to the files of the user's home; disabled when no home is recorded. */
function BrowseFilesButton({ user }: { readonly user: User }) {
  const label = `Browse files of ${user.displayName}`;
  const icon = <Icon name="folder" size={16} />;
  if (user.home === null) {
    return (
      <Tooltip content="No home folder">
        <IconButton label={label} size="sm" icon={icon} disabled />
      </Tooltip>
    );
  }
  // The shell follows links to /admin pages with the router.
  return <IconButtonLink href={userFilesHref(user.id)} label={label} size="sm" icon={icon} />;
}

function DefaultQuotaCard({ defaultQuotaBytes }: { readonly defaultQuotaBytes: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = bytesToGbText(defaultQuotaBytes);
  const [edited, setEdited] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const draft = edited ?? saved;
  const dirty = edited !== null && edited.trim() !== saved;

  const save = useMutation({
    mutationFn: (bytes: number) => api("setDefaultQuota", { body: { defaultQuotaBytes: bytes } }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Users>(usersQueryKey, (list) => (list === undefined ? list : { ...list, ...updated }));
      setEdited(null);
      toast.show({ tone: "success", title: "Default quota saved" });
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const bytes = gbToBytes(draft);
    setError(bytes === undefined ? quotaInvalidMessage : undefined);
    if (bytes !== undefined && dirty) save.mutate(bytes);
  };

  return (
    <Card title="Default quota" subtitle="The quota of every user without one of their own.">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        {save.isError && <Alert tone="danger">{problemMessage(save.error, "Saving the default quota did not work. Try again.")}</Alert>}
        <div className="flex flex-wrap items-end gap-3">
          <Input
            label="Default quota"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            className="w-48"
            suffix={<span className="type-body-sm text-fg-3">GB</span>}
            value={draft}
            onChange={(event) => setEdited(event.target.value)}
            {...errorProp(error)}
          />
          <Button type="submit" variant="secondary" disabled={!dirty} loading={save.isPending}>
            Save default quota
          </Button>
        </div>
      </form>
    </Card>
  );
}
