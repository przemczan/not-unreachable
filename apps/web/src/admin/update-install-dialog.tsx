import { problemTypes, type UpdatesOverview } from "@not-unreachable/contracts";
import { Button, Dialog } from "@not-unreachable/design-system";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
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
import { InstallElsewhere } from "./update-commands.tsx";
import { UpdateProgress, type UpdateProgressState } from "./update-progress.tsx";

const SUBMIT_LABEL = "Install and restart";

function installErrorOf(error: unknown, method: SecondFactorMethod): string {
  const proofRefused = reauthenticationErrorOf(error, method);
  if (proofRefused !== undefined) return proofRefused;
  if (isProblem(error, problemTypes.updateNotAvailable)) return "A newer release came out meanwhile. Check it, then install again.";
  if (isProblem(error, problemTypes.updateInProgress)) return "Another update is running. Wait for it to finish.";
  return problemMessage(error, "Installing did not work. Try again.");
}

export interface UpdateInstallDialogProps {
  readonly open: boolean;
  /** The release to install. */
  readonly version: string;
  /** The release this server runs. */
  readonly current: string;
  readonly install: UpdatesOverview["install"];
  /** The update once it was asked for; the dialog then follows it. */
  readonly progress: UpdateProgressState | null;
  readonly onClose: () => void;
  /** The server took the request, with its id; null when the service went away before answering. */
  readonly onRequested: (requestId: string | null) => void;
  /** The overview is out of date: installing was turned off, or another release or update is there. */
  readonly onStale: () => void;
  /** Waits for the service again after giving up. */
  readonly onRetry: () => void;
}

/**
 * Installs the latest release from here: the admin confirms with the password and a second factor,
 * then the dialog follows the update step by step until it ends (the caller closes it then).
 */
export function UpdateInstallDialog({
  open,
  version,
  current,
  install,
  progress,
  onClose,
  onRequested,
  onStale,
  onRetry,
}: UpdateInstallDialogProps) {
  const formId = useId();
  const [turnedOff, setTurnedOff] = useState(false);
  const passwordField = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const form = useReauthenticationForm(open);
  const following = progress !== null;

  // The form, and the submit button that had the focus, give way to the progress.
  useEffect(() => {
    if (open && following) closeButton.current?.focus();
  }, [open, following]);

  const request = useMutation({
    mutationFn: async (draft: ReauthenticationDraft): Promise<string | null> => {
      const reauthentication = await proveReauthentication(draft);
      try {
        return (await api("installUpdate", { body: { version, reauthentication } })).requestId;
      } catch (caught) {
        // The service may stop before its answer arrives: the update is under way all the same.
        if (isDroppedConnection(caught)) return null;
        throw caught;
      }
    },
    onSuccess: onRequested,
    onError: (caught) => {
      // The browser's own prompt ended without a passkey: PasskeyFailureAlert says so.
      if (isPasskeyCeremonyError(caught)) return;
      if (caught instanceof ApiError && caught.status === 404) {
        setTurnedOff(true);
        onStale();
        return;
      }
      if (isProblem(caught, problemTypes.updateNotAvailable) || isProblem(caught, problemTypes.updateInProgress)) onStale();
      form.refused(installErrorOf(caught, form.method), caught);
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft = form.validate();
    if (draft !== null) request.mutate(draft);
  };

  const close = (
    <Button variant="secondary" onClick={onClose}>
      Close
    </Button>
  );

  if (progress !== null) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={`Installing ${progress.to}`}
        description="You can close this; the Updates tab shows the progress too."
        actions={
          <Button ref={closeButton} variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <UpdateProgress state={progress} onRetry={onRetry} />
      </Dialog>
    );
  }

  if (turnedOff) {
    return (
      <Dialog open={open} onClose={onClose} title={`Install NotUnreachable ${version}`} actions={close}>
        <InstallElsewhere install={install} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      {...(request.isPending ? {} : { onClose })}
      initialFocus={passwordField}
      title={`Install NotUnreachable ${version}`}
      description={`The server downloads ${version}, checks its signature, installs it and restarts. This takes about a minute. If it doesn't start properly, the server goes back to ${current}.`}
      actions={
        <>
          <Button variant="secondary" disabled={request.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={request.isPending}>
            {SUBMIT_LABEL}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        <ReauthenticationFields
          form={form}
          passwordRef={passwordField}
          submitLabel={SUBMIT_LABEL}
          requestError={request.error}
          onMethodChange={() => request.reset()}
        />
      </form>
    </Dialog>
  );
}
