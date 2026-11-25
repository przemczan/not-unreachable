import {
  SHARE_LINK_PASSWORD_MAX_LENGTH,
  SHARE_LINK_PASSWORD_MIN_LENGTH,
  problemTypes,
  shareLinkAccesses,
  type ChangeShareLinkRequest,
  type CreateShareLinkRequest,
  type ShareLink,
  type ShareLinkAccess,
  type ShareLinkAllowedUser,
  type ShareLinkDetail,
  type ShareLinkKind,
} from "@not-unreachable/contracts";
import {
  Alert,
  Button,
  Checkbox,
  CopyField,
  Dialog,
  ExpiryPicker,
  Icon,
  Input,
  PasswordInput,
  RadioGroup,
  Switch,
  defaultExpiryValue,
  expiryDateOf,
  toLocalDateTimeInput,
  useToast,
  type ExpiryValue,
} from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { errorProp, isProblem, problemMessage } from "../lib/index.ts";
import { usersQueryKey } from "./user-dialogs.tsx";

/** The prefix of every Share links query; invalidated after a link is made, changed or revoked. */
export const shareLinksQueryKey = ["admin", "share-links"] as const;

/** What a new link shares: a file or folder of a resource. */
export interface ShareTarget {
  readonly resourceId: string;
  readonly path: string;
  readonly name: string;
  readonly kind: ShareLinkKind;
}

export type ShareLinkDialogProps =
  | { readonly target: ShareTarget; readonly shareLink?: never; readonly onClose: () => void }
  | { readonly shareLink: ShareLink; readonly target?: never; readonly onClose: () => void };

const passwordHint = `At least ${SHARE_LINK_PASSWORD_MIN_LENGTH} characters.`;

const accessOptions: { value: ShareLinkAccess; label: string; description: string }[] = [
  { value: "anyone", label: "Anyone with the link", description: "No account needed." },
  { value: "signed-in", label: "Signed-in users", description: "Anyone with the link who signs in here: users and you." },
  { value: "selected-users", label: "Selected users", description: "Only the users you pick, and you." },
];

function isAccess(value: string): value is ShareLinkAccess {
  return (shareLinkAccesses as readonly string[]).includes(value);
}

/** Who can open a link, for the dialog's description: "… can download report.pdf". */
const whoCanDownload: Record<ShareLinkAccess, string> = {
  anyone: "Anyone with the link",
  "signed-in": "Anyone with the link who signs in here",
  "selected-users": "Only the users you pick, and you,",
};

/** Who can open a link, once it is made. */
const whoCanOpen: Record<ShareLinkAccess, string> = {
  anyone: "Anyone with the link can open it.",
  "signed-in": "Only signed-in users can open it.",
  "selected-users": "Only the users you picked, and you, can open it.",
};

function shareProblemMessage(error: unknown, fallback: string): string {
  if (isProblem(error, problemTypes.shareLinkRevoked)) return "This link was revoked, so it can't change any more.";
  if (isProblem(error, problemTypes.notFound)) return "This file or folder no longer exists.";
  if (isProblem(error, problemTypes.pathRefused)) return "Only files and folders can be shared.";
  return problemMessage(error, fallback);
}

/** The picker's value for a link's expiry as it is: No expiry, or its time as a custom one. */
function expiryValueOf(shareLink: ShareLink): ExpiryValue {
  if (shareLink.noExpiry || shareLink.expiresAt === null) return { preset: "never", custom: "" };
  return { preset: "custom", custom: toLocalDateTimeInput(new Date(shareLink.expiresAt)) };
}

type ExpiryBody = { readonly expiresAt: string } | { readonly noExpiry: true };

interface FormErrors {
  password?: string | undefined;
  expiry?: string | undefined;
  users?: string | undefined;
}

/** The expiry for the API, or the error to show: "No expiry" is sent as `noExpiry: true`, on purpose. */
function expiryBodyOf(value: ExpiryValue): ExpiryBody | { readonly error: string } {
  const date = expiryDateOf(value);
  if (date === null) return { noExpiry: true };
  if (date === undefined) return { error: "Choose a date and time." };
  if (date.getTime() <= Date.now()) return { error: "Choose a time in the future." };
  return { expiresAt: date.toISOString() };
}

function passwordError(password: string): string | undefined {
  if (password.length < SHARE_LINK_PASSWORD_MIN_LENGTH) return `Use at least ${SHARE_LINK_PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > SHARE_LINK_PASSWORD_MAX_LENGTH) return `Use at most ${SHARE_LINK_PASSWORD_MAX_LENGTH} characters.`;
  return undefined;
}

/** A link's whole URL in a CopyField, with a Toast once copied. */
export function ShareLinkCopyField({ link }: { readonly link: string }) {
  const toast = useToast();
  return (
    <CopyField
      label="Link"
      value={link}
      onCopy={(outcome) => {
        if (outcome === "copied") toast.show({ tone: "success", title: "Link copied" });
      }}
    />
  );
}

function sameIds(picked: ReadonlySet<string>, users: readonly ShareLinkAllowedUser[]): boolean {
  return picked.size === users.length && users.every((user) => picked.has(user.id));
}

/**
 * Create a share link to a file or folder, or edit one: who can open it (with the users to pick for
 * "Selected users"), a password Switch with its PasswordInput, the ExpiryPicker (7 days by default)
 * with a warning for "No expiry", then the new link to copy.
 */
export function ShareLinkDialog({ target, shareLink, onClose }: ShareLinkDialogProps) {
  const formId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const editing = shareLink !== undefined;
  const name = shareLink?.name ?? target?.name ?? "";
  const kind = shareLink?.kind ?? target?.kind ?? "file";
  const hadPassword = shareLink?.hasPassword ?? false;

  const [requirePassword, setRequirePassword] = useState(hadPassword);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<ExpiryValue>(shareLink === undefined ? defaultExpiryValue : expiryValueOf(shareLink));
  const [expiryChanged, setExpiryChanged] = useState(false);
  const [access, setAccess] = useState<ShareLinkAccess>(shareLink?.access ?? "anyone");
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(shareLink?.allowedUsers.map((user) => user.id)));
  const [errors, setErrors] = useState<FormErrors>({});

  const onSaved = useCallback(() => void queryClient.invalidateQueries({ queryKey: shareLinksQueryKey }), [queryClient]);

  const create = useMutation({
    mutationFn: (body: CreateShareLinkRequest) => api("createShareLink", { body }),
    onSettled: onSaved,
  });
  const change = useMutation({
    mutationFn: (body: ChangeShareLinkRequest) => {
      if (shareLink === undefined) throw new Error("No link to change.");
      return api("changeShareLink", { params: { id: shareLink.id }, body });
    },
    onSuccess: () => {
      onClose();
      toast.show({ tone: "success", title: "Share link saved" });
    },
    onSettled: onSaved,
  });
  const saving = editing ? change : create;

  // In the edit dialog, a blank password with the Switch on keeps the current one.
  const passwordChange: string | null | undefined = !requirePassword
    ? hadPassword
      ? null
      : undefined
    : password === "" && hadPassword
      ? undefined
      : password;
  // The list is sent whole, and only with "Selected users"; in the edit dialog, only once changed.
  const accessChanged =
    shareLink === undefined || access !== shareLink.access || (access === "selected-users" && !sameIds(picked, shareLink.allowedUsers));
  const dirty = !editing || expiryChanged || passwordChange !== undefined || accessChanged;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: FormErrors = {};
    if (typeof passwordChange === "string") {
      const error = passwordError(passwordChange);
      if (error !== undefined) found.password = error;
    }
    const expiryBody = !editing || expiryChanged ? expiryBodyOf(expiry) : undefined;
    if (expiryBody !== undefined && "error" in expiryBody) found.expiry = expiryBody.error;
    if (accessChanged && access === "selected-users" && picked.size === 0) found.users = "Pick at least one user.";
    setErrors(found);
    if (found.password !== undefined || found.expiry !== undefined || found.users !== undefined) return;
    const expiryFields = expiryBody === undefined || "error" in expiryBody ? {} : expiryBody;
    const accessFields = !accessChanged ? {} : access === "selected-users" ? { access, allowedUserIds: [...picked] } : { access };

    if (target !== undefined) {
      create.mutate({
        resourceId: target.resourceId,
        path: target.path,
        ...(typeof passwordChange === "string" ? { password: passwordChange } : {}),
        ...accessFields,
        ...expiryFields,
      });
    } else {
      change.mutate({ ...expiryFields, ...(passwordChange === undefined ? {} : { password: passwordChange }), ...accessFields });
    }
  };

  if (create.isSuccess) return <ShareLinkCreated detail={create.data} onClose={onClose} />;

  const what = kind === "folder" ? `${name} and everything in it` : name;
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={editing ? `Edit the link to ${name}` : `Share ${name}`}
      description={
        editing
          ? "Changing or removing the password signs out everyone who has unlocked the link."
          : `${whoCanDownload[access]} can download ${what}, until it expires or you revoke it.`
      }
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving.isPending} disabled={!dirty}>
            {editing ? "Save changes" : "Create share link"}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        {saving.isError && (
          <Alert tone="danger">
            {shareProblemMessage(
              saving.error,
              editing ? "Saving the link did not work. Try again." : "Creating the link did not work. Try again.",
            )}
          </Alert>
        )}
        <RadioGroup
          label="Who can open it"
          value={access}
          onChange={(value) => {
            if (isAccess(value)) setAccess(value);
            setErrors((current) => ({ ...current, users: undefined }));
          }}
          options={accessOptions}
        />
        {access === "selected-users" && (
          <UserPicker
            picked={picked}
            listed={shareLink?.allowedUsers ?? []}
            error={errors.users}
            onChange={(next) => {
              setPicked(next);
              setErrors((current) => ({ ...current, users: undefined }));
            }}
          />
        )}
        <Switch
          label="Require a password"
          description="Whoever opens the link types it before they can download."
          checked={requirePassword}
          onChange={(checked) => {
            setRequirePassword(checked);
            setErrors((current) => ({ ...current, password: undefined }));
          }}
        />
        {requirePassword && (
          <PasswordInput
            label={hadPassword ? "New password" : "Password"}
            autoComplete="new-password"
            hint={hadPassword ? `Leave it empty to keep the current password. ${passwordHint}` : passwordHint}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...errorProp(errors.password)}
          />
        )}
        <ExpiryPicker
          value={expiry}
          onChange={(next) => {
            setExpiry(next);
            setExpiryChanged(true);
          }}
          {...errorProp(errors.expiry)}
        />
        {expiry.preset === "never" && (
          <Alert tone="warning" title="This link never expires">
            It works until you revoke it, for anyone who gets hold of it. Choose an expiry unless the link has to last.
          </Alert>
        )}
        {shareLink?.state === "expired" && !expiryChanged && (
          <Alert tone="info">This link has expired. Choose a new expiry to make it work again.</Alert>
        )}
      </form>
    </Dialog>
  );
}

function ShareLinkCreated({ detail, onClose }: { readonly detail: ShareLinkDetail; readonly onClose: () => void }) {
  const { shareLink } = detail;
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title="Share link created"
      description={`Copy the link and send it to whoever needs ${shareLink.name}. ${whoCanOpen[shareLink.access]}${shareLink.hasPassword ? " Send the password separately." : ""}`}
      actions={<Button onClick={onClose}>Done</Button>}
    >
      <ShareLinkCopyField link={detail.link} />
    </Dialog>
  );
}

interface UserPickerProps {
  readonly picked: ReadonlySet<string>;
  /** The users the link lists now: shown even once disabled, so they can be taken off. */
  readonly listed: readonly ShareLinkAllowedUser[];
  readonly error: string | undefined;
  readonly onChange: (picked: ReadonlySet<string>) => void;
}

interface PickableUser extends ShareLinkAllowedUser {
  readonly disabled: boolean;
}

/** The users to pick for "Selected users": every active user, and those already listed, with a filter. */
function UserPicker({ picked, listed, error, onChange }: UserPickerProps) {
  const errorId = useId();
  const [filter, setFilter] = useState("");
  const query = useQuery({ queryKey: usersQueryKey, queryFn: ({ signal }) => api("listUsers", { signal }) });

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
        {problemMessage(query.error, "Try again.")}
      </Alert>
    );
  }

  const listedIds = new Set(listed.map((user) => user.id));
  const known = new Set(query.data.users.map((user) => user.id));
  const users: PickableUser[] = [
    ...query.data.users
      .filter((user) => user.status === "active" || listedIds.has(user.id))
      .map(({ id, username, displayName, status }) => ({ id, username, displayName, disabled: status === "disabled" })),
    ...listed.filter((user) => !known.has(user.id)).map((user) => ({ ...user, disabled: false })),
  ].toSorted((a, b) => a.username.localeCompare(b.username));

  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ""
      ? users
      : users.filter((user) => user.username.toLowerCase().includes(needle) || user.displayName.toLowerCase().includes(needle));

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(picked);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  if (users.length === 0) {
    return (
      <Alert tone={error === undefined ? "info" : "danger"}>
        There are no active users yet. Invite one in Users, then share the link with them.
      </Alert>
    );
  }

  return (
    <fieldset aria-describedby={errorId} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 type-label text-fg-1">Users</legend>
      <Input
        aria-label="Filter users"
        placeholder="Filter by name or username"
        iconLeft={<Icon name="search" size={14} />}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="flex max-h-56 flex-col gap-2.5 overflow-y-auto rounded-control border border-solid border-border-subtle p-3">
        {shown.length === 0 ? (
          <p className="m-0 type-body-sm text-fg-3">No user matches “{filter.trim()}”.</p>
        ) : (
          shown.map((user) => (
            <Checkbox
              key={user.id}
              label={user.displayName}
              description={user.disabled ? `${user.username} · Disabled` : user.username}
              checked={picked.has(user.id)}
              onChange={(checked) => toggle(user.id, checked)}
            />
          ))
        )}
      </div>
      <p id={errorId} className={error === undefined ? "m-0 type-caption text-fg-3" : "m-0 type-caption text-danger-fg"}>
        {error ?? `${picked.size} ${picked.size === 1 ? "user" : "users"} picked.`}
      </p>
    </fieldset>
  );
}

export interface RevokeShareLinkDialogProps {
  readonly shareLink: ShareLink;
  readonly onClose: () => void;
}

export function RevokeShareLinkDialog({ shareLink, onClose }: RevokeShareLinkDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const revoke = useMutation({
    mutationFn: () => api("revokeShareLink", { params: { id: shareLink.id } }),
    onSuccess: () => {
      onClose();
      toast.show({ tone: "success", title: "Link revoked" });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: shareLinksQueryKey }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      tone="danger"
      title={`Revoke the link to ${shareLink.name}?`}
      description="It stops working at once, downloads in progress included. This can't be undone: make a new link to share it again."
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>
            Revoke link
          </Button>
        </>
      }
    >
      {revoke.isError ? (
        <Alert tone="danger">{shareProblemMessage(revoke.error, "Revoking the link did not work. Try again.")}</Alert>
      ) : null}
    </Dialog>
  );
}

/** Shows a link to copy by hand, when the clipboard refused it. */
export function CopyShareLinkDialog({
  name,
  link,
  onClose,
}: {
  readonly name: string;
  readonly link: string;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={`The link to ${name}`}
      description="The browser didn't let the link be copied. Copy it from here."
      actions={<Button onClick={onClose}>Done</Button>}
    >
      <ShareLinkCopyField link={link} />
    </Dialog>
  );
}
