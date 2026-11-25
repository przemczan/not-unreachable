import { problemTypes, quotaBytesSchema, type ChangeUserRequest, type HomeFolderChoice, type User } from "@not-unreachable/contracts";
import { Alert, Button, CopyField, Dialog, Input, RadioGroup, useToast } from "@not-unreachable/design-system";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { BYTES_PER_GB, errorProp, formatBytes, isProblem, problemMessage } from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";

export const usersQueryKey = ["admin", "users"] as const;

/** A failure worth an Alert: not the admin cancelling the recent sign-in. */
function failureOf(error: Error | null): Error | null {
  return error === null || isRecentSignInCancelled(error) ? null : error;
}

function userProblemMessage(error: unknown, fallback: string): string {
  if (isProblem(error, problemTypes.lastSignInMethod)) {
    return "This is their last way to sign in, so it can't be unlinked. Send them a re-link link instead.";
  }
  if (isProblem(error, problemTypes.notFound)) return "This user no longer exists.";
  return problemMessage(error, fallback);
}

export interface UserDialogProps {
  readonly user: User;
  readonly onClose: () => void;
}

/** Saves a change of the user, then closes the dialog with a Toast. */
function useChangeUser(user: User, onClose: () => void, done: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: ChangeUserRequest) => api("changeUser", { params: { id: user.id }, body }),
    onSuccess: () => {
      onClose();
      toast.show({ tone: "success", title: done });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: usersQueryKey }),
  });
}

export function DisableUserDialog({ user, onClose }: UserDialogProps) {
  const disabling = user.status === "active";
  const change = useChangeUser(user, onClose, disabling ? "User disabled" : "User enabled");
  return (
    <Dialog
      open
      onClose={onClose}
      {...(disabling ? { tone: "danger" as const } : {})}
      title={disabling ? `Disable ${user.displayName}?` : `Enable ${user.displayName}?`}
      description={
        disabling
          ? "They can't sign in until you enable them again, and every session they have ends now. Their files stay."
          : "They can sign in again with their linked sign-ins."
      }
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={disabling ? "danger" : "primary"}
            loading={change.isPending}
            onClick={() => change.mutate({ status: disabling ? "disabled" : "active" })}
          >
            {disabling ? "Disable user" : "Enable user"}
          </Button>
        </>
      }
    >
      {change.isError ? <Alert tone="danger">{userProblemMessage(change.error, "That did not work. Try again.")}</Alert> : null}
    </Dialog>
  );
}

/** A quota typed in GB as bytes; undefined when it isn't a number the contract takes. */
export function gbToBytes(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const gb = Number(trimmed);
  if (!Number.isFinite(gb)) return undefined;
  const parsed = quotaBytesSchema.safeParse(Math.round(gb * BYTES_PER_GB));
  return parsed.success ? parsed.data : undefined;
}

export function bytesToGbText(bytes: number): string {
  return String(bytes / BYTES_PER_GB);
}

export const quotaInvalidMessage = "Enter a size in GB, such as 10 or 2.5.";

type QuotaChoice = "default" | "custom";

export interface QuotaDialogProps extends UserDialogProps {
  readonly defaultQuotaBytes: number;
}

export function QuotaDialog({ user, defaultQuotaBytes, onClose }: QuotaDialogProps) {
  const formId = useId();
  const change = useChangeUser(user, onClose, "Quota saved");
  const [choice, setChoice] = useState<QuotaChoice>(user.quotaBytes === null ? "default" : "custom");
  const [gb, setGb] = useState(user.quotaBytes === null ? "" : bytesToGbText(user.quotaBytes));
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (choice === "default") {
      change.mutate({ quotaBytes: null });
      return;
    }
    const bytes = gbToBytes(gb);
    setError(bytes === undefined ? quotaInvalidMessage : undefined);
    if (bytes !== undefined) change.mutate({ quotaBytes: bytes });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Set the quota of ${user.displayName}`}
      description="The most their home may hold, uploads in progress included."
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={change.isPending}>
            Save quota
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-3">
        {change.isError && <Alert tone="danger">{userProblemMessage(change.error, "Saving the quota did not work. Try again.")}</Alert>}
        <RadioGroup
          label="Quota"
          value={choice}
          onChange={(value) => setChoice(value === "custom" ? "custom" : "default")}
          options={[
            { value: "default", label: `Use the default (${formatBytes(defaultQuotaBytes)})` },
            { value: "custom", label: "Custom" },
          ]}
        />
        {choice === "custom" && (
          <Input
            label="Custom quota"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            className="w-48"
            suffix={<span className="type-body-sm text-fg-3">GB</span>}
            value={gb}
            onChange={(event) => setGb(event.target.value)}
            {...errorProp(error)}
          />
        )}
      </form>
    </Dialog>
  );
}

export function UnlinkSignInDialog({ user, onClose }: UserDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [linkId, setLinkId] = useState(user.linkedSignIns[0]?.id ?? "");
  const unlink = useMutation({
    mutationFn: (link: string) => api("removeUserLinkedSignIn", { params: { id: user.id, link } }),
    onSuccess: () => {
      onClose();
      toast.show({ tone: "success", title: "Sign-in unlinked" });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: usersQueryKey }),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      tone="danger"
      title={`Unlink a sign-in of ${user.displayName}?`}
      description="They can no longer sign in with the one you choose. Their other linked sign-ins keep working."
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={unlink.isPending} disabled={linkId === ""} onClick={() => unlink.mutate(linkId)}>
            Unlink
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {unlink.isError && <Alert tone="danger">{userProblemMessage(unlink.error, "Unlinking did not work. Try again.")}</Alert>}
        <RadioGroup
          label="Linked sign-in"
          value={linkId}
          onChange={setLinkId}
          options={user.linkedSignIns.map((linked) => ({
            value: linked.id,
            label: linked.providerName,
            description: linked.email ?? "No email shared",
          }))}
        />
      </div>
    </Dialog>
  );
}

export function RelinkLinkDialog({ user, onClose }: UserDialogProps) {
  const toast = useToast();
  const { run } = useRecentSignIn();
  const create = useMutation({
    mutationFn: () => run(() => api("createRelinkLink", { params: { id: user.id } })),
  });
  const failure = failureOf(create.error);

  if (create.isSuccess) {
    const { link, emailed } = create.data;
    return (
      <Dialog
        open
        onClose={onClose}
        title="Re-link link created"
        description={emailed && user.email !== null ? `Emailed to ${user.email}.` : "Copy it and send it to them."}
        actions={<Button onClick={onClose}>Done</Button>}
      >
        <div className="flex flex-col gap-2">
          <CopyField
            label="Re-link link"
            value={link}
            onCopy={(outcome) => {
              if (outcome === "copied") toast.show({ tone: "success", title: "Link copied" });
            }}
          />
          <p className="m-0 type-caption text-fg-3">It works once, for one day.</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Send a re-link link to ${user.displayName}?`}
      description="The link lets them sign in with a new provider account. Using it removes their old linked sign-ins and signs them out everywhere."
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={() => create.mutate()}>
            Create link
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {failure !== null && <Alert tone="danger">{userProblemMessage(failure, "Creating the link did not work. Try again.")}</Alert>}
        <p className="m-0 type-body-sm text-fg-2">
          It works once, for one day. A re-link link sent before stops working.
          {user.email === null ? " They have no email, so you'll copy it and send it yourself." : ""}
        </p>
      </div>
    </Dialog>
  );
}

export function RemoveUserDialog({ user, onClose }: UserDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [homeFolder, setHomeFolder] = useState<HomeFolderChoice>("keep");
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: (choice: HomeFolderChoice) => run(() => api("removeUser", { params: { id: user.id }, body: { homeFolder: choice } })),
    onSuccess: () => {
      onClose();
      toast.show({ tone: "success", title: "User removed" });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: usersQueryKey }),
  });
  const failure = failureOf(remove.error);
  const confirmed = typed.trim() === user.username;

  return (
    <Dialog
      open
      onClose={onClose}
      tone="danger"
      title={`Remove ${user.displayName}?`}
      description="Their account, linked sign-ins and sessions are removed. This can't be undone."
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!confirmed} loading={remove.isPending} onClick={() => remove.mutate(homeFolder)}>
            Remove user
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {failure !== null && <Alert tone="danger">{userProblemMessage(failure, "Removing the user did not work. Try again.")}</Alert>}
        <RadioGroup
          label="Home folder"
          value={homeFolder}
          onChange={(value) => setHomeFolder(value === "delete" ? "delete" : "keep")}
          options={[
            { value: "keep", label: "Keep files", description: "Their home folder stays. The username stays reserved while it exists." },
            { value: "delete", label: "Delete files", description: "Their home folder and everything in it is deleted." },
          ]}
        />
        <Input
          label={`Type ${user.username} to confirm`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
    </Dialog>
  );
}
