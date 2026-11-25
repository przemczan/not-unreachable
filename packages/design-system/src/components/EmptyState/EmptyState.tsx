import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon, type IconName } from "../Icon/index.ts";

export interface EmptyStateProps {
  /**
   * The icon in the tile.
   * @defaultValue "inbox"
   */
  icon?: IconName;
  /** Why it's empty: "No files yet". */
  title: React.ReactNode;
  /** What to do: "Upload files or create a folder to start." */
  description?: React.ReactNode;
  /** A Button for that next step. */
  action?: React.ReactNode;
  /**
   * Less padding, for inside a table or a small Card.
   * @defaultValue false
   */
  compact?: boolean;
  className?: string;
}

/**
 * What an empty list shows instead: an icon tile, a title saying why it's empty, a line saying what
 * to do, and the action that does it.
 *
 * @example
 * <EmptyState icon="folder-open" title="No files yet" description="Upload files or create a folder to start." action={<Button>Upload files</Button>} />
 */
export function EmptyState({ icon = "inbox", title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3 text-center", compact ? "px-4 py-6" : "px-6 py-12", className)}>
      <span className="grid size-10 place-items-center rounded-card border border-solid border-border bg-surface-sunken text-fg-3">
        <Icon name={icon} size={20} />
      </span>
      <div className="max-w-90">
        <p className="m-0 type-card-title text-fg-1">{title}</p>
        {description != null && <p className="m-0 mt-1 type-body-sm text-fg-3">{description}</p>}
      </div>
      {action}
    </div>
  );
}
