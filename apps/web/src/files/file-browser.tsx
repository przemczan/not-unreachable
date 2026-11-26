import { problemTypes, type Entry } from "@not-unreachable/contracts";
import {
  Alert,
  Breadcrumbs,
  Button,
  Card,
  DataTable,
  DropZone,
  EmptyState,
  Icon,
  IconButton,
  IconButtonLink,
  Menu,
  PageHeader,
  UploadQueue,
  useToast,
  type DataTableColumn,
  type IconName,
  type MenuItem,
  type UploadQueueItem,
} from "@not-unreachable/design-system";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { Link, useNavigate } from "react-router";
import { formatBytes, formatDateTime, formatRelative, isProblem, problemMessage } from "../lib/index.ts";
import { ConflictDialog, DeleteEntryDialog, NewFolderDialog } from "./file-dialogs.tsx";
import { iconOf, joinPath, segmentsOf } from "./paths.ts";
import { useEntrySort, type EntrySort } from "./sort.ts";
import type { FileSource } from "./source.ts";
import type { UploadRecord, UploadStore } from "./upload-store.ts";
import { useUploads } from "./use-uploads.ts";

export interface FileBrowserProps {
  readonly source: FileSource;
  /** The folder shown, "" for the top one; it lives in the URL. */
  readonly path: string;
  /** The URL that shows a folder. */
  readonly hrefOf: (path: string) => string;
  /** The top folder's name in the Breadcrumbs: "Files", or the resource's name. */
  readonly rootLabel: string;
  readonly title: string;
  readonly description?: React.ReactNode;
  /** Next to the title: the QuotaMeter, or the admin's resource picker. */
  readonly aside?: React.ReactNode;
  readonly uploads: UploadStore;
  /** Called after an upload finishes, besides reloading the listing (the quota, say). */
  readonly onUploaded?: () => void;
  /**
   * More buttons on a file's or folder's row, before its menu: the admin's "Share link". The browser
   * itself knows nothing of them, so a user's browser never loads the admin's code.
   */
  readonly entryButtons?: (entry: Entry, entryPath: string) => readonly EntryButton[];
}

/** A button on an entry's row, beside Download and the row menu. */
export interface EntryButton {
  /** Its accessible name and title, naming the entry: "Share report.pdf". */
  readonly label: string;
  readonly icon: IconName;
  readonly onClick: () => void;
}

function noteOf(upload: UploadRecord): string | undefined {
  if (upload.conflict) return "Waiting for your choice: replace or keep both";
  if (upload.needsFile) return `Choose ${upload.name} again to resume`;
  return upload.state === "paused" ? upload.error : undefined;
}

function toQueueItem(upload: UploadRecord): UploadQueueItem {
  return {
    id: upload.id,
    name: upload.name,
    bytesSent: upload.bytesSent,
    bytesTotal: upload.bytesTotal,
    // A name-taken upload waits for the Replace / Keep both dialog rather than counting as failed.
    state: upload.conflict ? "queued" : upload.state,
    error: upload.error,
    note: noteOf(upload),
  };
}

/** Only files and folders have actions: the server never follows or deletes a link or a special file (T5). */
function hasActions(entry: Entry): boolean {
  return entry.kind === "file" || entry.kind === "folder";
}

function entriesKey(source: FileSource, path: string, sort: EntrySort): readonly unknown[] {
  return [...source.queryKey, "entries", path, sort.key, sort.order];
}

/** Whether two listings' keys are of the same folder, whatever their sort. */
function sameFolder(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.slice(0, -2).every((part, index) => part === b[index]);
}

/** A folder's name opens it; a file's is only its name, as Download is its own button. */
function NameCell({ entry, href }: { readonly entry: Entry; readonly href: string }) {
  const icon = (
    <span className={entry.kind === "folder" ? "grid text-accent" : "grid text-fg-3"}>
      <Icon name={iconOf(entry.kind, entry.name)} size={16} />
    </span>
  );
  const name = <span className="truncate">{entry.name}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {icon}
      {entry.kind === "folder" ? (
        <Link to={href} className="min-w-0 truncate font-medium text-fg-1 no-underline hover:text-link hover:underline">
          {entry.name}
        </Link>
      ) : entry.kind === "file" ? (
        <span className="min-w-0 truncate text-fg-1">{entry.name}</span>
      ) : (
        <>
          {name}
          <span className="type-body-sm text-fg-3">{entry.kind === "link" ? "Link (not followed)" : "Not a file or folder"}</span>
        </>
      )}
    </span>
  );
}

/**
 * The file browser of both interfaces: a folder's entries (folders first, then by the remembered
 * sort), Breadcrumbs for the path, upload by button or drop, new folder, download and delete, and
 * the upload queue.
 */
export function FileBrowser({
  source,
  path,
  hrefOf,
  rootLabel,
  title,
  description,
  aside,
  uploads,
  onUploaded,
  entryButtons,
}: FileBrowserProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const records = useUploads(uploads);
  const conflict = records.find((record) => record.conflict);
  const [sort, sortBy] = useEntrySort();

  // The sort is in the key, as a cursor holds only for its own sort: a new one lists from the first page.
  // Meanwhile the folder stays in its old order, so the header just clicked keeps the focus.
  const queryKey = entriesKey(source, path, sort);
  const listing = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => source.list(path, sort, pageParam, signal),
    placeholderData: (previous, previousQuery) =>
      previousQuery !== undefined && sameFolder(previousQuery.queryKey, queryKey) ? previous : undefined,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  // Toast and reload when an upload finishes.
  const onUploadedRef = useRef(onUploaded);
  useEffect(() => {
    onUploadedRef.current = onUploaded;
  }, [onUploaded]);
  useEffect(
    () =>
      uploads.onDone(({ upload }) => {
        toast.show({ tone: "success", title: "Upload complete", description: upload.name });
        void queryClient.invalidateQueries({ queryKey: source.queryKey });
        onUploadedRef.current?.();
      }),
    [uploads, toast, queryClient, source.queryKey],
  );

  const addFiles = (files: readonly File[]) => {
    if (files.length > 0) uploads.add(files, source.uploadTarget(path));
  };

  const chooseFiles = () => fileInput.current?.click();

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    // The same file may be chosen again (to resume an upload, say).
    event.target.value = "";
  };

  const entries = listing.data?.pages.flatMap((page) => page.entries) ?? [];
  const segments = segmentsOf(path);

  const menuItemsOf = (entry: Entry): MenuItem[] => {
    const deleteItem: MenuItem = {
      label: "Delete",
      icon: <Icon name="trash-2" size={14} />,
      danger: true,
      onSelect: () => setDeleting(entry),
    };
    if (entry.kind !== "folder") return [deleteItem];
    const entryPath = joinPath(path, entry.name);
    return [
      { label: "Open", icon: <Icon name="folder-open" size={14} />, onSelect: () => void navigate(hrefOf(entryPath)) },
      { divider: true },
      deleteItem,
    ];
  };

  const rowActionsOf = (entry: Entry) => {
    const entryPath = joinPath(path, entry.name);
    return (
      <span className="inline-flex items-center gap-1">
        {entry.kind === "file" && (
          <IconButtonLink
            href={source.contentUrl(entryPath)}
            download={entry.name}
            label={`Download ${entry.name}`}
            size="sm"
            icon={<Icon name="download" size={16} />}
          />
        )}
        {entryButtons?.(entry, entryPath).map((button) => (
          <IconButton
            key={button.label}
            label={button.label}
            size="sm"
            icon={<Icon name={button.icon} size={16} />}
            onClick={button.onClick}
          />
        ))}
        <Menu
          trigger={<IconButton label={`Actions for ${entry.name}`} size="sm" icon={<Icon name="more-horizontal" size={16} />} />}
          items={menuItemsOf(entry)}
        />
      </span>
    );
  };

  const columns: DataTableColumn<Entry>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      render: (entry) => <NameCell entry={entry} href={hrefOf(joinPath(path, entry.name))} />,
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      width: 120,
      muted: true,
      sortable: true,
      render: (entry) => (entry.kind === "file" ? formatBytes(entry.size) : "—"),
    },
    {
      // Named as the sort it sets, not the entry's field.
      key: "modified",
      header: "Modified",
      width: 160,
      muted: true,
      sortable: true,
      render: (entry) => (
        <time dateTime={entry.modifiedAt} title={formatDateTime(entry.modifiedAt)}>
          {formatRelative(entry.modifiedAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      // Room for Download, the admin's Share link and the menu.
      width: 128,
      render: (entry) => (hasActions(entry) ? rowActionsOf(entry) : null),
    },
  ];

  const uploadButton = (
    <Button iconLeft={<Icon name="upload" size={14} />} onClick={chooseFiles}>
      Upload files
    </Button>
  );

  // The queue closes (dropping its finished rows) only once nothing in it can go on.
  const unfinished = records.some((record) => record.state !== "done" && record.state !== "failed");

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {aside}
            <Button variant="secondary" iconLeft={<Icon name="folder-plus" size={14} />} onClick={() => setCreatingFolder(true)}>
              New folder
            </Button>
            {uploadButton}
          </>
        }
      />
      <input ref={fileInput} type="file" multiple hidden aria-label="Files to upload" data-testid="upload-input" onChange={onInputChange} />

      {segments.length > 0 && (
        <Breadcrumbs
          items={[
            { label: rootLabel, href: hrefOf(""), onClick: () => void navigate(hrefOf("")) },
            ...segments.map((segment, index) => {
              const crumbPath = segments.slice(0, index + 1).join("/");
              return { label: segment, href: hrefOf(crumbPath), onClick: () => void navigate(hrefOf(crumbPath)) };
            }),
          ]}
        />
      )}

      <Card padding="none">
        {listing.isPending ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading files…</p>
        ) : listing.isError ? (
          <div className="p-5">
            {/* At the top folder a 404 means the home itself is missing: its own message says so. */}
            {isProblem(listing.error, problemTypes.notFound) && segments.length > 0 ? (
              <Alert
                tone="warning"
                title="This folder doesn't exist"
                action={
                  <Button variant="secondary" size="sm" onClick={() => void navigate(hrefOf(""))}>
                    Go to the top folder
                  </Button>
                }
              >
                It may have been deleted or renamed.
              </Alert>
            ) : (
              <Alert
                tone="danger"
                title="Files could not be loaded"
                action={
                  <Button variant="secondary" size="sm" onClick={() => void listing.refetch()}>
                    Try again
                  </Button>
                }
              >
                {problemMessage(listing.error, "Reload the page to try again.")}
              </Alert>
            )}
          </div>
        ) : (
          <>
            <DataTable
              caption={segments.length === 0 ? rootLabel : `${rootLabel} / ${segments.join(" / ")}`}
              columns={columns}
              rows={entries}
              rowKey={(entry) => entry.name}
              sort={sort}
              onSortChange={sortBy}
              highlightRowOnHover
              empty={
                <EmptyState
                  icon="folder-open"
                  title={segments.length === 0 ? "No files yet" : "This folder is empty"}
                  description="Upload files or create a folder. You can also drop files anywhere on the page."
                  action={uploadButton}
                />
              }
            />
            {listing.hasNextPage && (
              <div className="flex justify-center border-t border-solid border-border-subtle p-3">
                <Button variant="secondary" size="sm" loading={listing.isFetchingNextPage} onClick={() => void listing.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      <DropZone onFiles={addFiles} description={segments.length === 0 ? `Into ${rootLabel}` : `Into ${segments.at(-1) ?? rootLabel}`} />

      <UploadQueue
        items={records.map(toQueueItem)}
        onPause={uploads.pause}
        onResume={(id) => {
          if (records.find((record) => record.id === id)?.needsFile) chooseFiles();
          else uploads.resume(id);
        }}
        onCancel={uploads.cancel}
        {...(unfinished ? {} : { onClose: uploads.clearFinished })}
      />

      {deleting !== null && <DeleteEntryDialog source={source} folder={path} entry={deleting} onClose={() => setDeleting(null)} />}
      {creatingFolder && <NewFolderDialog source={source} folder={path} onClose={() => setCreatingFolder(false)} />}
      {conflict !== undefined && (
        <ConflictDialog
          upload={conflict}
          onReplace={() => uploads.resolveConflict(conflict.id, "replace")}
          onKeepBoth={() => uploads.resolveConflict(conflict.id, "keep-both")}
          onCancel={() => uploads.cancel(conflict.id)}
        />
      )}
    </>
  );
}
