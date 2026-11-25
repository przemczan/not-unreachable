import { problemTypes, type HomeRoot, type Resource, type ResourceList } from "@not-unreachable/contracts";
import { Alert, Button, Card, Combobox, DescriptionList, Dialog, RadioGroup, useToast } from "@not-unreachable/design-system";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { errorProp, isProblem, problemMessage } from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";
import { useFolderSuggestions } from "./folder-suggestions.ts";
import { resourcesQueryKey } from "./resource-drawer.tsx";
import { resourceLocationOf, unavailableReasonLabels } from "./resource-wording.tsx";

/** Why the server refused the subfolder (a path or name refusal), as the admin reads it. */
const subfolderRefusals: Readonly<Record<string, string>> = {
  invalid: "Enter folder names with / between them, such as homes or people/homes.",
  "too-long": "This path is too long.",
  symlink: "This path goes through a symbolic link. Choose another folder.",
  "outside-root": "The folder must be inside the resource.",
  "special-file": "Something other than a folder has this name. Choose another folder.",
  "not-a-folder": "Something other than a folder has this name. Choose another folder.",
  "reserved-character": "A folder name holds a character that isn't allowed: < > : \" | ? *",
  "control-character": "A folder name holds a control character.",
  "reserved-name": "A folder name is one Windows reserves, such as CON or NUL.",
  "trailing-dot-or-space": "A folder name ends with a dot or a space.",
  dot: "A folder name can't be . or ..",
};

const subfolderRefusedFallback = "This folder can't hold the homes. Choose another one.";

/** The subfolder as saved: trimmed, without the trailing `/` a chosen suggestion leaves. */
function savedSubpathOf(typed: string): string {
  return typed.trim().replace(/\/+$/, "");
}

interface Draft {
  readonly resourceId: string | null;
  readonly subpath: string;
}

export interface HomeRootCardProps {
  readonly resources: readonly Resource[];
  readonly homeRoot: HomeRoot | null;
}

/** The home root: the resource, and the folder in it, where each new user's home is made. */
export function HomeRootCard({ resources, homeRoot }: HomeRootCardProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const saved: Draft = { resourceId: homeRoot?.resourceId ?? null, subpath: homeRoot?.subpath ?? "" };
  const [edited, setEdited] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const draft = edited ?? saved;
  const subpath = savedSubpathOf(draft.subpath);
  const dirty = edited !== null && (edited.resourceId !== saved.resourceId || subpath !== saved.subpath);
  const chosen = resources.find((resource) => resource.id === draft.resourceId);
  const suggestions = useFolderSuggestions(chosen, draft.subpath);

  const save = useMutation({
    mutationFn: (body: { resourceId: string; subpath: string }) => run(() => api("setHomeRoot", { body })),
    onSuccess: (updated) => {
      queryClient.setQueryData<ResourceList>(resourcesQueryKey, (list) => (list === undefined ? list : { ...list, homeRoot: updated }));
      setConfirming(false);
      setEdited(null);
      void queryClient.invalidateQueries({ queryKey: resourcesQueryKey });
      toast.show({ tone: "success", title: "Home root saved", description: "New homes are created in this place." });
    },
    onError: (error) => {
      if (!isRecentSignInCancelled(error)) setConfirming(false);
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.resourceId === null || !dirty) return;
    save.reset();
    setConfirming(true);
  };

  const confirm = () => {
    if (draft.resourceId !== null) save.mutate({ resourceId: draft.resourceId, subpath });
  };

  const failure: unknown = save.isError && !isRecentSignInCancelled(save.error) ? save.error : null;
  const subfolderError =
    failure !== null && isProblem(failure, problemTypes.pathRefused)
      ? (subfolderRefusals[failure.problem.reason ?? ""] ?? subfolderRefusedFallback)
      : undefined;
  const otherFailure = failure !== null && subfolderError === undefined ? failure : null;

  return (
    <Card title="Home root" subtitle="The resource, and the folder in it, where each new user's home is created.">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {homeRoot === null && (
          <Alert tone="warning" title="No home root yet">
            Users can't be invited until a home root is chosen.
          </Alert>
        )}
        {otherFailure !== null && (
          <Alert tone="danger">
            {isProblem(otherFailure, problemTypes.resourceUnavailable)
              ? "This resource is unavailable. Retry it, or choose another resource."
              : problemMessage(otherFailure, "Saving the home root did not work. Try again.")}
          </Alert>
        )}
        {resources.length === 0 ? (
          <p className="m-0 type-body-sm text-fg-3">Add a folder first, then choose it as the home root.</p>
        ) : (
          <>
            <RadioGroup
              label="Home root"
              value={draft.resourceId ?? ""}
              onChange={(resourceId) => setEdited({ ...draft, resourceId })}
              options={resources.map((resource) => ({
                value: resource.id,
                label: resource.name,
                description:
                  resource.state === "available"
                    ? resourceLocationOf(resource)
                    : `Unavailable: ${unavailableReasonLabels[resource.unavailableReason ?? "missing"]}`,
                disabled: resource.state !== "available",
              }))}
            />
            <Combobox
              label="Subfolder"
              hint="Optional. A folder inside the resource, such as homes; it is created when missing. Leave it empty for the resource's top folder."
              placeholder="homes"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="max-w-120"
              value={draft.subpath}
              onChange={(event) => setEdited({ ...draft, subpath: event.target.value })}
              options={suggestions.options}
              loading={suggestions.loading}
              loadingLabel="Loading folders…"
              closeOnSelect={false}
              onSelect={(chosenPath) => setEdited({ ...draft, subpath: chosenPath })}
              {...errorProp(subfolderError)}
            />
            <div className="flex items-center justify-end gap-3">
              {dirty && <span className="mr-auto type-body-sm text-fg-2">You have unsaved changes</span>}
              <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => setEdited(null)}>
                Discard changes
              </Button>
              <Button type="submit" disabled={!dirty || draft.resourceId === null}>
                Save home root
              </Button>
            </div>
          </>
        )}
      </form>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={homeRoot === null ? "Set the home root?" : "Change the home root?"}
        description="Existing homes stay where they are. Only homes created from now on are made in the new place."
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={confirm}>
              Save home root
            </Button>
          </>
        }
      >
        <DescriptionList
          labelWidth={110}
          items={[
            { label: "Resource", value: chosen?.name },
            {
              label: "Subfolder",
              value: subpath === "" ? "The resource's top folder" : subpath,
              mono: subpath !== "",
            },
          ]}
        />
      </Dialog>
    </Card>
  );
}
