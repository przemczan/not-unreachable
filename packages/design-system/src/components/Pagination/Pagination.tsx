import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Button } from "../Button/index.ts";
import { Icon } from "../Icon/index.ts";

export interface PaginationProps {
  /** An earlier page exists; without it "Previous" is disabled. */
  hasPrevious?: boolean;
  /** A later page exists; without it "Next" is disabled. */
  hasNext?: boolean;
  /** Called on "Previous": load the page before the current cursor. */
  onPrevious?: () => void;
  /** Called on "Next": load the page after the current cursor. */
  onNext?: () => void;
  /** Text at the left, such as "Showing 50 events" or "1–50 of 1,284"; tabular figures. */
  summary?: React.ReactNode;
  /** Disables both buttons while a page loads. */
  loading?: boolean;
  /**
   * Names the navigation landmark.
   * @defaultValue "Pagination"
   */
  "aria-label"?: string;
  className?: string;
}

/**
 * Cursor pagination for lists that page by cursor rather than by page number (the audit log):
 * an optional summary at the left, "Previous" and "Next" at the right, each disabled when there is
 * no page that way. It replaces the source's numbered pagination, which needs a page count.
 *
 * @example
 * <Pagination summary="Showing 50 events" hasPrevious={cursors.length > 0} hasNext={page.nextCursor !== null} onPrevious={back} onNext={forward} />
 */
export function Pagination({
  hasPrevious = false,
  hasNext = false,
  onPrevious,
  onNext,
  summary,
  loading = false,
  "aria-label": ariaLabel = "Pagination",
  className,
}: PaginationProps) {
  return (
    <nav aria-label={ariaLabel} className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      {summary != null ? <span className="type-body-sm text-fg-3 tabular-nums">{summary}</span> : <span />}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasPrevious || loading}
          onClick={onPrevious}
          iconLeft={<Icon name="chevron-left" size={14} />}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasNext || loading}
          onClick={onNext}
          iconRight={<Icon name="chevron-right" size={14} />}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
