import {
  problemTypes,
  RESOURCE_NAME_MAX_CHARACTERS,
  type Resource,
  type ResourceCheck,
  type ResourceKind,
} from "@not-unreachable/contracts";
import { Alert, Button, Drawer, Icon, Input, useToast } from "@not-unreachable/design-system";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { errorProp, isProblem, problemMessage } from "../lib/index.ts";
import { AllowFolderDialog } from "./allow-folder-dialog.tsx";
import { resourcesQueryKey, saveMutationKey } from "./resource-keys.ts";
import { folderRefusalOf, ResourceCheckAlert } from "./resource-wording.tsx";
import { SmbShareForm } from "./smb-share-form.tsx";

export { resourcesQueryKey } from "./resource-keys.ts";

/** What the Drawer is open for: a new resource of a kind, or one resource to edit. */
export type ResourceDrawerState =
  { readonly mode: "add"; readonly kind: ResourceKind } | { readonly mode: "edit"; readonly resource: Resource } | null;

type LocalResource = Extract<Resource, { kind: "local" }>;

interface FormErrors {
  readonly name?: string;
  readonly localPath?: string;
}

interface Draft {
  readonly name: string;
  readonly localPath: string;
}

function errorsOf(draft: Draft): FormErrors {
  const name = draft.name.trim();
  const errors: { name?: string; localPath?: string } = {};
  if (name === "") errors.name = "Enter a name.";
  else if (name.length > RESOURCE_NAME_MAX_CHARACTERS) errors.name = `Use at most ${RESOURCE_NAME_MAX_CHARACTERS} characters.`;
  if (draft.localPath.trim() === "") errors.localPath = "Enter the folder's path on the server.";
  return errors;
}

export interface ResourceDrawerProps {
  readonly state: ResourceDrawerState;
  readonly onClose: () => void;
}

/** The Drawer's title, description and submit label for what it is open for. */
function wordingOf(state: NonNullable<ResourceDrawerState>): { title: string; description: string; submit: string } {
  if (state.mode === "edit") return { title: "Edit resource", description: state.resource.name, submit: "Save changes" };
  return state.kind === "smb"
    ? { title: "Add SMB share", description: "A network share that NotUnreachable mounts and stores files in.", submit: "Add share" }
    : { title: "Add folder", description: "A folder on the server that NotUnreachable stores files in.", submit: "Add folder" };
}

/** The Drawer to add a local folder or an SMB share, or edit a resource. */
export function ResourceDrawer({ state, onClose }: ResourceDrawerProps) {
  const formId = useId();
  const saving = useIsMutating({ mutationKey: saveMutationKey }) > 0;
  const wording = state === null ? null : wordingOf(state);
  const editing = state?.mode === "edit" ? state.resource : null;
  const kind = state === null ? null : state.mode === "edit" ? state.resource.kind : state.kind;
  return (
    <Drawer
      open={state !== null}
      onClose={onClose}
      title={wording?.title}
      description={wording?.description}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {wording?.submit ?? "Save"}
          </Button>
        </>
      }
    >
      {/* A fresh form each time the Drawer opens, so nothing typed for the last one stays. */}
      {kind === "smb" && (
        <SmbShareForm key={editing?.id ?? "new-smb"} formId={formId} resource={editing?.kind === "smb" ? editing : null} onDone={onClose} />
      )}
      {kind === "local" && (
        <ResourceForm
          key={editing?.id ?? "new-local"}
          formId={formId}
          resource={editing?.kind === "local" ? editing : null}
          onDone={onClose}
        />
      )}
    </Drawer>
  );
}

interface ResourceFormProps {
  readonly formId: string;
  readonly resource: LocalResource | null;
  readonly onDone: () => void;
}

function ResourceForm({ formId, resource, onDone }: ResourceFormProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({ name: resource?.name ?? "", localPath: resource?.localPath ?? "" });
  const [errors, setErrors] = useState<FormErrors>({});
  /** The last "Check folder" result or refused save, for the path it was about. */
  const [result, setResult] = useState<ResourceCheck | null>(null);
  /** Whether `result` is a refused save, which goes on by itself once the folder is allowed. */
  const [saveRefused, setSaveRefused] = useState(false);
  /** "Allow this folder" is open; each opening gets a fresh dialog. */
  const [allowing, setAllowing] = useState(false);
  const [allowRound, setAllowRound] = useState(0);

  const check = useMutation({
    mutationFn: (localPath: string) => api("checkResource", { body: { kind: "local", localPath } }),
    onMutate: () => setResult(null),
    onSuccess: setResult,
  });

  const save = useMutation({
    mutationKey: saveMutationKey,
    mutationFn: (values: Draft) =>
      resource === null
        ? api("addResource", { body: { kind: "local", name: values.name, localPath: values.localPath } })
        : api("changeResource", { params: { id: resource.id }, body: { kind: "local", name: values.name, localPath: values.localPath } }),
    onMutate: () => check.reset(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: resourcesQueryKey });
      toast.show({ tone: "success", title: resource === null ? "Folder added" : "Resource saved" });
      onDone();
    },
    onError: (error) => {
      const refusal = folderRefusalOf(error);
      if (refusal !== null) {
        setResult(refusal);
        setSaveRefused(true);
      } else if (isProblem(error, problemTypes.resourceNameTaken)) setErrors({ name: "Another resource already has this name." });
    },
  });

  const update = (change: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...change }));
    if (change.localPath !== undefined) {
      setResult(null);
      setSaveRefused(false);
      check.reset();
    }
  };

  const checkFolder = () => {
    const localPath = draft.localPath.trim();
    if (localPath === "") {
      setErrors({ ...errors, localPath: "Enter the folder's path on the server." });
      return;
    }
    setErrors(errors.name === undefined ? {} : { name: errors.name });
    setSaveRefused(false);
    check.mutate(localPath);
  };

  const saveDraft = () => {
    const found = errorsOf(draft);
    setErrors(found);
    if (found.name !== undefined || found.localPath !== undefined) return;
    setResult(null);
    save.mutate({ name: draft.name.trim(), localPath: draft.localPath.trim() });
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveDraft();
  };

  const openAllow = () => {
    setAllowRound((previous) => previous + 1);
    setAllowing(true);
  };

  // The service is back with the folder allowed: anything loaded before the restart may be stale.
  // Check the folder again, and go on with the save the folder held up.
  const folderAllowed = () => {
    setAllowing(false);
    void queryClient.invalidateQueries();
    const resumeSave = saveRefused;
    setSaveRefused(false);
    check.mutate(draft.localPath.trim(), {
      onSuccess: (checked) => {
        if (resumeSave && checked.outcome === "ok") saveDraft();
      },
    });
  };

  // Allowing from here was turned off on the server meanwhile: only the command is left.
  const allowTurnedOff = () => {
    setResult((current) => (current?.outcome === "refused" ? { ...current, allowFromUi: false } : current));
  };

  const saveFailed = save.isError && folderRefusalOf(save.error) === null && !isProblem(save.error, problemTypes.resourceNameTaken);

  return (
    <div className="flex flex-col gap-5">
      {resource?.unavailableReason === "changed" && (
        <Alert tone="warning" title="The folder changed since it was saved">
          Another folder is at this path now, or the path leads somewhere else. Check the folder, then save to use the folder that is at
          this path now.
        </Alert>
      )}
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        {saveFailed && <Alert tone="danger">{problemMessage(save.error, "Saving did not work. Try again.")}</Alert>}
        <Input
          label="Name"
          hint="How the resource is shown in NotUnreachable."
          maxLength={RESOURCE_NAME_MAX_CHARACTERS}
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
          {...errorProp(errors.name)}
        />
        <Input
          label="Folder path"
          hint="The full path of the folder on the server, such as /srv/files."
          placeholder="/srv/files"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputClassName="type-mono"
          value={draft.localPath}
          onChange={(event) => update({ localPath: event.target.value })}
          {...errorProp(errors.localPath)}
        />
        <div className="flex items-center gap-3">
          <Button variant="secondary" iconLeft={<Icon name="folder-open" size={14} />} loading={check.isPending} onClick={checkFolder}>
            Check folder
          </Button>
          <span className="type-body-sm text-fg-3">Checks the folder without saving anything.</span>
        </div>
      </form>
      {check.isError && <Alert tone="danger">{problemMessage(check.error, "Checking the folder did not work. Try again.")}</Alert>}
      {result !== null && <ResourceCheckAlert result={result} onAllowFolder={openAllow} />}
      {result?.outcome === "refused" && (
        <AllowFolderDialog
          key={allowRound}
          open={allowing}
          localPath={draft.localPath.trim()}
          command={result.command}
          onCancel={() => setAllowing(false)}
          onTurnedOff={allowTurnedOff}
          onAllowed={folderAllowed}
        />
      )}
    </div>
  );
}
