import {
  DEFAULT_INVITATION_EXPIRY_DAYS,
  emailSchema,
  invitationExpiryDays,
  problemTypes,
  type CreateInvitationRequest,
  type Invitation,
  type InvitationExpiryDays,
  type InvitationState,
} from "@not-unreachable/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  CopyField,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Menu,
  Select,
  useToast,
  type BadgeProps,
  type DataTableColumn,
  type MenuItem,
} from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { Link } from "react-router";
import { api } from "../api/index.ts";
import { errorProp, formatDateTime, isProblem, problemMessage } from "../lib/index.ts";
import { mailSettingsQueryKey } from "./mail-settings.tsx";

export const invitationsQueryKey = ["admin", "invitations"] as const;

const stateBadges: Record<InvitationState, { readonly label: string; readonly tone: NonNullable<BadgeProps["tone"]> }> = {
  pending: { label: "Pending", tone: "info" },
  accepted: { label: "Accepted", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "danger" },
};

const expiryOptions = invitationExpiryDays.map((days) => ({ value: String(days), label: days === 1 ? "1 day" : `${days} days` }));

function expiryOf(value: string): InvitationExpiryDays {
  return invitationExpiryDays.find((days) => String(days) === value) ?? DEFAULT_INVITATION_EXPIRY_DAYS;
}

const smtpNotConfiguredMessage = "Set up email on the Email tab of Settings first.";

function invitationProblemMessage(error: unknown, fallback: string): string {
  if (isProblem(error, problemTypes.smtpNotConfigured)) return smtpNotConfiguredMessage;
  if (isProblem(error, problemTypes.invitationInvalid)) return "This invitation is no longer pending.";
  if (isProblem(error, problemTypes.mailSendFailed)) return "The email could not be sent. Check the Email settings and try again.";
  return problemMessage(error, fallback);
}

export interface InvitationsTabProps {
  readonly onInvite: () => void;
}

/** Admin → Users → Invitations: every invitation, newest first. */
export function InvitationsTab({ onInvite }: InvitationsTabProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const query = useQuery({ queryKey: invitationsQueryKey, queryFn: ({ signal }) => api("listInvitations", { signal }) });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: invitationsQueryKey });

  const copyLink = useMutation({
    mutationFn: async (invitation: Invitation) => {
      const { link } = await api("getInvitationLink", { params: { id: invitation.id } });
      try {
        await navigator.clipboard.writeText(link);
        return { link, copied: true };
      } catch {
        return { link, copied: false };
      }
    },
    onSuccess: ({ link, copied }) => {
      if (copied) toast.show({ tone: "success", title: "Link copied" });
      else toast.show({ tone: "warning", title: "Copying did not work", description: `Copy the link by hand: ${link}` });
    },
    onError: (error) => {
      toast.show({ tone: "danger", title: "The link could not be loaded", description: invitationProblemMessage(error, "Try again.") });
      invalidate();
    },
  });

  const resend = useMutation({
    mutationFn: (invitation: Invitation) => api("resendInvitation", { params: { id: invitation.id } }),
    onSuccess: (invitation) => {
      toast.show({
        tone: "success",
        title: "Invitation sent",
        ...(invitation.email === null ? {} : { description: `Emailed to ${invitation.email}.` }),
      });
    },
    onError: (error) => {
      toast.show({ tone: "danger", title: "The invitation was not sent", description: invitationProblemMessage(error, "Try again.") });
    },
    onSettled: invalidate,
  });

  const revoke = useMutation({
    mutationFn: (invitation: Invitation) => api("revokeInvitation", { params: { id: invitation.id } }),
    onSuccess: () => {
      setRevoking(null);
      toast.show({ tone: "success", title: "Invitation revoked" });
    },
    onSettled: invalidate,
  });

  const actionsOf = (invitation: Invitation): MenuItem[] => [
    { label: "Copy link", icon: <Icon name="copy" size={14} />, onSelect: () => copyLink.mutate(invitation) },
    ...(!invitation.sendByEmail
      ? []
      : [{ label: "Resend", icon: <Icon name="mail" size={14} />, onSelect: () => resend.mutate(invitation) }]),
    { divider: true },
    {
      label: "Revoke",
      icon: <Icon name="trash-2" size={14} />,
      danger: true,
      onSelect: () => {
        revoke.reset();
        setRevoking(invitation);
      },
    },
  ];

  const columns: DataTableColumn<Invitation>[] = [
    {
      key: "email",
      header: "Email",
      wrap: true,
      render: (invitation) =>
        invitation.email === null ? (
          <span className="text-fg-3">No email</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{invitation.email}</span>
            {invitation.sendByEmail && <Badge tone="neutral">Sent by email</Badge>}
            {invitation.verifyEmail && <Badge tone="info">Verified email required</Badge>}
          </div>
        ),
    },
    {
      key: "state",
      header: "State",
      render: (invitation) => (
        <Badge tone={stateBadges[invitation.state].tone} dot>
          {stateBadges[invitation.state].label}
        </Badge>
      ),
    },
    {
      key: "expiresAt",
      header: "Expires",
      render: (invitation) => <time dateTime={invitation.expiresAt}>{formatDateTime(invitation.expiresAt)}</time>,
    },
    {
      key: "createdAt",
      header: "Created",
      render: (invitation) => <time dateTime={invitation.createdAt}>{formatDateTime(invitation.createdAt)}</time>,
    },
    { key: "acceptedUsername", header: "Account", render: (invitation) => invitation.acceptedUsername ?? "—" },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (invitation) =>
        invitation.state === "pending" ? (
          <Menu
            width={220}
            trigger={
              <IconButton
                label={`Actions for the invitation ${invitation.email ?? "without an email"}`}
                size="sm"
                icon={<Icon name="more-horizontal" size={16} />}
              />
            }
            items={actionsOf(invitation)}
          />
        ) : null,
    },
  ];

  return (
    <>
      <Card padding="none">
        {query.isPending ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading invitations…</p>
        ) : query.isError ? (
          <div className="p-5">
            <Alert
              tone="danger"
              title="Invitations could not be loaded"
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
            caption="Invitations"
            columns={columns}
            rows={query.data.invitations}
            empty={
              <EmptyState
                icon="mail"
                title="No invitations yet"
                description="Invite someone to let them create an account."
                action={
                  <Button iconLeft={<Icon name="user-plus" size={14} />} onClick={onInvite}>
                    Invite user
                  </Button>
                }
              />
            }
          />
        )}
      </Card>

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        tone="danger"
        title="Revoke this invitation?"
        description={
          revoking?.email == null ? "Its link stops working at once." : `The link sent to ${revoking.email} stops working at once.`
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() => {
                if (revoking !== null) revoke.mutate(revoking);
              }}
            >
              Revoke invitation
            </Button>
          </>
        }
      >
        {revoke.isError ? <Alert tone="danger">{invitationProblemMessage(revoke.error, "Revoking did not work. Try again.")}</Alert> : null}
      </Dialog>
    </>
  );
}

export interface InviteDialogProps {
  readonly onClose: () => void;
}

/** "Invite user": a new invitation, then its link to copy. Mounted afresh for each one. */
export function InviteDialog({ onClose }: InviteDialogProps) {
  const formId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [expiry, setExpiry] = useState(String(DEFAULT_INVITATION_EXPIRY_DAYS));
  const [sendByEmail, setSendByEmail] = useState(false);
  const [verifyEmail, setVerifyEmail] = useState(false);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);

  // A failed load counts as "not set up": sending stays off rather than failing on create.
  const mail = useQuery({ queryKey: mailSettingsQueryKey, queryFn: ({ signal }) => api("getMailSettings", { signal }) });
  const smtpReady = mail.data?.smtp != null;
  const hasEmail = email.trim() !== "";
  const sending = sendByEmail && hasEmail && smtpReady;
  const verifying = sending || (verifyEmail && hasEmail);

  const create = useMutation({
    mutationFn: (body: CreateInvitationRequest) => api("createInvitation", { body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: invitationsQueryKey }),
  });

  if (create.isSuccess) {
    const { link, emailed, invitation } = create.data;
    const description =
      emailed && invitation.email !== null
        ? `We emailed the invitation to ${invitation.email}. You can also copy the link and send it yourself.`
        : invitation.sendByEmail
          ? "The email could not be sent. Copy the link and send it yourself, or use Resend on the Invitations tab to try again."
          : "Copy the link and send it to the person you're inviting.";
    return (
      <Dialog open onClose={onClose} title="Invitation created" description={description} actions={<Button onClick={onClose}>Done</Button>}>
        <div className="flex flex-col gap-2">
          <CopyField
            label="Invitation link"
            value={link}
            onCopy={(outcome) => {
              if (outcome === "copied") toast.show({ tone: "success", title: "Link copied" });
            }}
          />
          <p className="m-0 type-caption text-fg-3">
            It works once, until <time dateTime={invitation.expiresAt}>{formatDateTime(invitation.expiresAt)}</time>.
            {invitation.verifyEmail ? " Accepting it needs an account whose verified email is the one it was created for." : ""}
          </p>
        </div>
      </Dialog>
    );
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = email.trim();
    const invalid = trimmed !== "" && !emailSchema.safeParse(trimmed).success;
    setEmailError(invalid ? "Enter an email address, such as name@example.com, or leave it empty." : undefined);
    if (invalid) return;
    create.mutate({
      ...(trimmed === "" ? {} : { email: trimmed }),
      expiresInDays: expiryOf(expiry),
      sendByEmail: sending,
      verifyEmail: verifying,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite user"
      description="Create a single-use link that lets one person create an account."
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            Create invitation
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        {create.isError &&
          (isProblem(create.error, problemTypes.homeRootNotSet) ? (
            <Alert tone="warning" title="No home root yet">
              Set the home root on the{" "}
              <Link to="/admin/resources" className="text-link hover:text-link-hover">
                Resources page
              </Link>{" "}
              first.
            </Alert>
          ) : (
            <Alert tone="danger">{invitationProblemMessage(create.error, "Creating the invitation did not work. Try again.")}</Alert>
          ))}
        <Input
          label="Email"
          type="email"
          autoComplete="off"
          hint="Optional."
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          {...errorProp(emailError)}
        />
        <div className="flex flex-col gap-3">
          <Checkbox
            label="Send the invitation to this email"
            description={
              !hasEmail
                ? "Enter an email address first."
                : !smtpReady
                  ? "Set up email on the Email tab of Settings first."
                  : "The link is emailed to this address."
            }
            checked={sending}
            disabled={!hasEmail || !smtpReady}
            onChange={setSendByEmail}
          />
          <Checkbox
            label="Require a verified matching email"
            description={
              sending
                ? "Always on when the invitation is emailed. Accepting needs an SSO account whose provider reports this email as verified."
                : "Accepting needs an SSO account whose provider reports this email as verified."
            }
            checked={verifying}
            disabled={!hasEmail || sending}
            onChange={setVerifyEmail}
          />
        </div>
        <Select label="Expires after" options={expiryOptions} value={expiry} onChange={setExpiry} />
      </form>
    </Dialog>
  );
}
