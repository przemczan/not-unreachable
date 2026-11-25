import { allowFolderRefusals, problemTypes, type AllowFolderRefusal } from "@not-unreachable/contracts";
import { Alert, Button, CopyField, Dialog, Icon, useToast } from "@not-unreachable/design-system";
import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import type * as React from "react";
import { ApiError, api } from "../api/index.ts";
import { isProblem, problemMessage } from "../lib/index.ts";
import { isPasskeyCeremonyError } from "../second-factors/index.ts";
import {
  ReauthenticationFields,
  isDroppedConnection,
  proveReauthentication,
  reauthenticationErrorOf,
  useReauthenticationForm,
  type ReauthenticationDraft,
  type SecondFactorMethod,
} from "./reauthentication.tsx";
import { allowFolderRefusalMessages } from "./resource-wording.tsx";
import { useServiceComeback, type ServiceWaitTiming } from "./service-restart.ts";

/**
 * How the dialog waits for the service to come back after allowing a folder, in milliseconds. The
 * server restarts 3 s after its 202, so a health check that answers before then is the old process:
 * the service counts as back once a check has failed, or `settleMs` has passed, and one then answers.
 * Tests shorten these.
 */
export const allowFolderTiming: ServiceWaitTiming = {
  firstCheckMs: 1500,
  checkEveryMs: 1000,
  checkTimeoutMs: 5000,
  settleMs: 6000,
  giveUpMs: 90_000,
};

/** The command that shows why the service didn't come back. */
const JOURNAL_COMMAND = "journalctl -u not-unreachable";

function isAllowFolderRefusal(reason: string | undefined): reason is AllowFolderRefusal {
  return allowFolderRefusals.some((refusal) => refusal === reason);
}

function allowErrorOf(error: unknown, method: SecondFactorMethod): string {
  const proofRefused = reauthenticationErrorOf(error, method);
  if (proofRefused !== undefined) return proofRefused;
  if (isProblem(error, problemTypes.folderNotAllowable)) {
    const { reason } = error.problem;
    return isAllowFolderRefusal(reason) ? allowFolderRefusalMessages[reason] : "This folder can't be allowed from here.";
  }
  if (isProblem(error, problemTypes.badRequest) && error.status === 409)
    return "The service can already write to this folder. Close this and check the folder again.";
  // The server isn't set up to allow folders: its detail says what to run on it.
  if (isProblem(error, problemTypes.serviceUnavailable) && error.problem.detail !== undefined) return error.problem.detail;
  return problemMessage(error, "Allowing the folder did not work. Try again.");
}

/**
 * What the dialog shows: the form, the wait for the restart (since when, so Retry waits the whole
 * time again), or why it stopped.
 */
type Phase =
  | { readonly kind: "form" }
  | { readonly kind: "restarting"; readonly since: number }
  | { readonly kind: "gave-up" }
  | { readonly kind: "turned-off" };

export interface AllowFolderDialogProps {
  readonly open: boolean;
  /** The folder to allow. */
  readonly localPath: string;
  /** The `sudo not-unreachable allow-folder` line, shown when allowing from here is turned off. */
  readonly command: string | null;
  readonly onCancel: () => void;
  /** Allowing from here is turned off on the server: the caller shows only the command from now on. */
  readonly onTurnedOff: () => void;
  /** The folder is allowed and the service is back. */
  readonly onAllowed: () => void;
}

/**
 * Lets the service write to a folder from here: the admin confirms with the password and a second
 * factor, then the service restarts and the dialog waits until it answers again.
 */
export function AllowFolderDialog({ open, localPath, command, onCancel, onTurnedOff, onAllowed }: AllowFolderDialogProps) {
  const formId = useId();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const passwordField = useRef<HTMLInputElement>(null);
  const form = useReauthenticationForm(open);

  const startWaiting = () => setPhase({ kind: "restarting", since: Date.now() });

  const allow = useMutation({
    mutationFn: async (draft: ReauthenticationDraft) => {
      const reauthentication = await proveReauthentication(draft);
      try {
        await api("allowFolder", { body: { localPath, reauthentication } });
      } catch (caught) {
        // The service may stop before its answer arrives: it is restarting all the same.
        if (!isDroppedConnection(caught)) throw caught;
      }
    },
    onSuccess: startWaiting,
    onError: (caught) => {
      // The browser's own prompt ended without a passkey: PasskeyFailureAlert says so.
      if (isPasskeyCeremonyError(caught)) return;
      if (caught instanceof ApiError && caught.status === 404) {
        setPhase({ kind: "turned-off" });
        onTurnedOff();
        return;
      }
      form.refused(allowErrorOf(caught, form.method), caught);
    },
  });

  useServiceComeback(phase.kind === "restarting" ? phase.since : null, allowFolderTiming, onAllowed, () => setPhase({ kind: "gave-up" }));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft = form.validate();
    if (draft !== null) allow.mutate(draft);
  };

  if (phase.kind === "restarting" || phase.kind === "gave-up") {
    return (
      <Dialog
        open={open}
        title="Restarting the service"
        description={`The service can write to ${localPath} once it is back.`}
        actions={
          phase.kind === "gave-up" ? (
            <>
              <Button variant="secondary" onClick={onCancel}>
                Close
              </Button>
              <Button onClick={startWaiting}>Retry</Button>
            </>
          ) : undefined
        }
      >
        {phase.kind === "restarting" ? (
          <output className="flex items-center gap-2 type-body text-fg-2">
            <Icon name="loader-circle" size={16} className="animate-spin" />
            <span>Restarting the service… This takes a few seconds.</span>
          </output>
        ) : (
          <Alert tone="danger" title="The service didn't come back">
            Check it on the server: <code className="type-mono">{JOURNAL_COMMAND}</code>
          </Alert>
        )}
      </Dialog>
    );
  }

  if (phase.kind === "turned-off") {
    return (
      <Dialog
        open={open}
        onClose={onCancel}
        title="Allow this folder"
        actions={
          <Button variant="secondary" onClick={onCancel}>
            Close
          </Button>
        }
      >
        <Alert tone="warning" title="Allowing folders from here is turned off">
          <div className="mt-1 flex flex-col gap-2">
            <p className="m-0">Run this command on the server instead, then check the folder again.</p>
            {command !== null && (
              <CopyField
                label="Command"
                value={command}
                onCopy={(outcome) => {
                  if (outcome === "copied") toast.show({ tone: "success", title: "Command copied" });
                }}
              />
            )}
          </div>
        </Alert>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      {...(allow.isPending ? {} : { onClose: onCancel })}
      initialFocus={passwordField}
      title="Allow this folder"
      description={
        <>
          The service will be able to write to <span className="type-mono">{localPath}</span>. It then restarts, which takes a few seconds;
          everyone signed in stays signed in.
        </>
      }
      actions={
        <>
          <Button variant="secondary" disabled={allow.isPending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={allow.isPending}>
            Allow and restart
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        <ReauthenticationFields
          form={form}
          passwordRef={passwordField}
          submitLabel="Allow and restart"
          requestError={allow.error}
          onMethodChange={() => allow.reset()}
        />
      </form>
    </Dialog>
  );
}
