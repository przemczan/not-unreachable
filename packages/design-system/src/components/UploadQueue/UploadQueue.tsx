import { useId, useState } from "react";
import { cn } from "../../lib/cn.ts";
import { formatBytes, formatBytesOf } from "../../lib/formatBytes.ts";
import { Card } from "../Card/index.ts";
import { Icon } from "../Icon/index.ts";
import { IconButton } from "../IconButton/index.ts";
import { ProgressBar, type ProgressBarTone } from "../ProgressBar/index.ts";

export type UploadQueueState = "queued" | "uploading" | "paused" | "done" | "failed";

/** One upload, as the queue shows it. */
export interface UploadQueueItem {
  id: string;
  /** The file's name. */
  name: string;
  bytesSent: number;
  bytesTotal: number;
  state: UploadQueueState;
  /** Why it failed, in words; shown instead of "Upload failed". */
  error?: string | undefined;
  /** A line shown instead of the status, such as what to do to resume. */
  note?: string | undefined;
}

export interface UploadQueueProps {
  /** The uploads, in the order they were added. */
  items: UploadQueueItem[];
  /** Shows a Pause button on each upload in progress. */
  onPause?: (id: string) => void;
  /** Shows a Resume button on each paused upload. */
  onResume?: (id: string) => void;
  /** Shows a Cancel button on each unfinished upload (and Remove on a failed one). */
  onCancel?: (id: string) => void;
  /** Shows a close button in the header; leave it out while it shouldn't be closed. */
  onClose?: () => void;
  /**
   * Opens with only the header showing.
   * @defaultValue false
   */
  defaultCollapsed?: boolean;
  className?: string;
}

const statusTone: Record<UploadQueueState, ProgressBarTone> = {
  queued: "neutral",
  uploading: "accent",
  paused: "neutral",
  done: "success",
  failed: "danger",
};

function statusOf(item: UploadQueueItem): string {
  if (item.note !== undefined) return item.note;
  const bytes = formatBytesOf(item.bytesSent, item.bytesTotal);
  const statuses: Record<UploadQueueState, string> = {
    queued: `Waiting · ${formatBytes(item.bytesTotal)}`,
    uploading: bytes,
    paused: `Paused · ${bytes}`,
    done: `Uploaded · ${formatBytes(item.bytesTotal)}`,
    failed: item.error ?? "Upload failed",
  };
  return statuses[item.state];
}

function summaryOf(items: readonly UploadQueueItem[]): string {
  const done = items.filter((item) => item.state === "done").length;
  const failed = items.filter((item) => item.state === "failed").length;
  const parts = [`${done} of ${items.length} uploaded`];
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

interface UploadRowProps {
  readonly item: UploadQueueItem;
  readonly onPause: ((id: string) => void) | undefined;
  readonly onResume: ((id: string) => void) | undefined;
  readonly onCancel: ((id: string) => void) | undefined;
}

function UploadRow({ item, onPause, onResume, onCancel }: UploadRowProps) {
  const unfinished = item.state !== "done";
  return (
    <li className="flex items-center gap-3 border-b border-solid border-border-subtle px-4 py-2.5 last:border-b-0">
      <span className={cn("grid flex-none", item.state === "failed" ? "text-danger-fg" : "text-fg-3")}>
        <Icon name={item.state === "done" ? "circle-check" : item.state === "failed" ? "circle-alert" : "file"} size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="truncate type-body-sm font-medium text-fg-1" title={item.name}>
          {item.name}
        </span>
        <ProgressBar
          size="sm"
          label={`Upload of ${item.name}`}
          value={item.bytesSent}
          max={Math.max(item.bytesTotal, 1)}
          tone={statusTone[item.state]}
        />
        <span className={cn("truncate type-caption", item.state === "failed" ? "text-danger-fg" : "text-fg-3")}>{statusOf(item)}</span>
      </div>
      <div className="flex flex-none items-center gap-0.5">
        {item.state === "uploading" && onPause && (
          <IconButton
            size="sm"
            label={`Pause upload of ${item.name}`}
            icon={<Icon name="pause" size={14} />}
            onClick={() => onPause(item.id)}
          />
        )}
        {item.state === "paused" && onResume && (
          <IconButton
            size="sm"
            label={`Resume upload of ${item.name}`}
            icon={<Icon name="play" size={14} />}
            onClick={() => onResume(item.id)}
          />
        )}
        {unfinished && onCancel && (
          <IconButton
            size="sm"
            label={item.state === "failed" ? `Remove upload of ${item.name}` : `Cancel upload of ${item.name}`}
            icon={<Icon name="x" size={14} />}
            onClick={() => onCancel(item.id)}
          />
        )}
      </div>
    </li>
  );
}

/**
 * The uploads of the page, docked bottom-right: a raised Card with a row per file (name,
 * ProgressBar, status, and Pause / Resume / Cancel), and a header with how many are done and
 * collapse and close controls. Purely presentational: the caller keeps the uploads and their state.
 *
 * @example
 * <UploadQueue items={uploads} onPause={pause} onResume={resume} onCancel={cancel} onClose={clear} />
 */
export function UploadQueue({ items, onPause, onResume, onCancel, onClose, defaultCollapsed = false, className }: UploadQueueProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const listId = useId();
  if (items.length === 0) return null;
  const active = items.filter((item) => item.state !== "done" && item.state !== "failed").length;
  return (
    <Card
      variant="raised"
      padding="none"
      title={active > 0 ? `Uploading ${active} ${active === 1 ? "file" : "files"}` : "Uploads"}
      subtitle={summaryOf(items)}
      className={cn("fixed right-6 bottom-6 z-drawer w-96 max-w-full shadow-floating", className)}
      actions={
        <>
          <IconButton
            size="sm"
            label={collapsed ? "Expand uploads" : "Collapse uploads"}
            aria-expanded={!collapsed}
            aria-controls={listId}
            icon={<Icon name={collapsed ? "chevron-up" : "chevron-down"} size={16} />}
            onClick={() => setCollapsed(!collapsed)}
          />
          {onClose && <IconButton size="sm" label="Close uploads" icon={<Icon name="x" size={16} />} onClick={onClose} />}
        </>
      }
    >
      <ul id={listId} hidden={collapsed} className="m-0 max-h-80 list-none overflow-y-auto p-0">
        {items.map((item) => (
          <UploadRow key={item.id} item={item} onPause={onPause} onResume={onResume} onCancel={onCancel} />
        ))}
      </ul>
    </Card>
  );
}
