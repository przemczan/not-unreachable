import { problemTypes, type Entry } from "@not-unreachable/contracts";
import { Alert, Button, Dialog, Input, useToast } from "@not-unreachable/design-system";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { errorProp, isProblem, problemMessage } from "../lib/index.ts";
import { joinPath } from "./paths.ts";
import type { FileSource } from "./source.ts";
import type { UploadRecord } from "./upload-store.ts";

const kindWords = { file: "file", folder: "folder", link: "link", other: "item" } as const;
const deletedTitles = { file: "File deleted", folder: "Folder deleted", link: "Link deleted", other: "Item deleted" } as const;

export interface DeleteEntryDialogProps {
  readonly source: FileSource;
  /** The folder the entry is in. */
  readonly folder: string;
  readonly entry: Entry;
  readonly onClose: () => void;
}

/** Confirms deleting a file, a link or a folder; a folder goes with everything in it (recursive). */
export function DeleteEntryDialog({ source, folder, entry, onClose }: DeleteEntryDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const isFolder = entry.kind === "folder";
  const word = kindWords[entry.kind];
  const remove = useMutation({
    mutationFn: () => source.remove(joinPath(folder, entry.name), isFolder),
    onSuccess: () => {
      onClose();
      toast.show({ tone: "success", title: deletedTitles[entry.kind], description: entry.name });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: source.queryKey }),
  });
  return (
    <Dialog
      open
      tone="danger"
      onClose={onClose}
      title={`Delete ${entry.name}?`}
      description={
        isFolder
          ? "Everything in this folder is deleted too, with all its subfolders. This can't be undone."
          : `The ${word} is deleted from the server. This can't be undone.`
      }
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            {`Delete ${word}`}
          </Button>
        </>
      }
    >
      {remove.isError ? (
        <Alert tone="danger">
          {isProblem(remove.error, problemTypes.notFound)
            ? "It's no longer there: someone deleted or moved it."
            : problemMessage(remove.error, "Deleting did not work. Try again.")}
        </Alert>
      ) : null}
    </Dialog>
  );
}

export interface NewFolderDialogProps {
  readonly source: FileSource;
  /** The folder the new one goes into. */
  readonly folder: string;
  readonly onClose: () => void;
}

/** Names and creates a folder in the current one. */
export function NewFolderDialog({ source, folder, onClose }: NewFolderDialogProps) {
  const formId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const create = useMutation({
    mutationFn: (folderName: string) => source.createFolder(folder, folderName),
    onSuccess: (entry) => {
      onClose();
      toast.show({ tone: "success", title: "Folder created", description: entry.name });
    },
    onError: (failure) => {
      if (isProblem(failure, problemTypes.nameTaken)) setError("Something with this name is already in this folder.");
      else if (isProblem(failure, problemTypes.pathRefused) || isProblem(failure, problemTypes.validationFailed)) {
        setError("This name can't be used. Leave out / and characters the server's disk doesn't allow.");
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: source.queryKey }),
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Enter a name.");
      return;
    }
    if (trimmed.includes("/") || trimmed === "." || trimmed === "..") {
      setError("A folder name can't contain / or be . or ..");
      return;
    }
    setError(undefined);
    create.mutate(trimmed);
  };

  const otherFailure = create.isError && error === undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title="New folder"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            Create folder
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-3">
        <Input
          label="Folder name"
          value={name}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
          {...errorProp(error)}
        />
        {otherFailure ? <Alert tone="danger">{problemMessage(create.error, "Creating the folder did not work. Try again.")}</Alert> : null}
      </form>
    </Dialog>
  );
}

export interface ConflictDialogProps {
  readonly upload: UploadRecord;
  readonly onReplace: () => void;
  readonly onKeepBoth: () => void;
  readonly onCancel: () => void;
}

/** Asks what to do when an upload's name is taken in its folder (409 name-taken). */
export function ConflictDialog({ upload, onReplace, onKeepBoth, onCancel }: ConflictDialogProps) {
  const where = upload.folder === "" ? "the top folder" : upload.folder;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Replace ${upload.name}?`}
      description={`A file named ${upload.name} is already in ${where}. Replace it with the one you are uploading, or keep both: the new one gets a number after its name.`}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel upload
          </Button>
          <Button variant="secondary" onClick={onKeepBoth}>
            Keep both
          </Button>
          <Button variant="primary" onClick={onReplace}>
            Replace file
          </Button>
        </>
      }
    />
  );
}
