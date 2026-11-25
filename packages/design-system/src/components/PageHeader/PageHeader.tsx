import type * as React from "react";
import { cn } from "../../lib/cn.ts";

export interface PageHeaderProps {
  /** The page's title, its one `h1`. */
  title: React.ReactNode;
  /** A sentence under the title. */
  description?: React.ReactNode;
  /** Right-aligned buttons: at most one primary. */
  actions?: React.ReactNode;
  /** Inline after the title: a status Badge, an ID. */
  meta?: React.ReactNode;
  /** Above the title: a back link or Breadcrumbs. */
  eyebrow?: React.ReactNode;
  /** Below everything, usually Tabs. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * The block at the top of a page: title, description, inline meta and actions; put Tabs in
 * `children`.
 *
 * @example
 * <PageHeader title="Users" description="Everyone with access to NotUnreachable." actions={<Button>Invite user</Button>} />
 */
export function PageHeader({ title, description, actions, meta, eyebrow, children, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 shrink grow basis-80">
          {eyebrow != null && <div className="mb-1.5">{eyebrow}</div>}
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 type-page-title text-fg-1">{title}</h1>
            {meta}
          </div>
          {description != null && <p className="m-0 mt-1 max-w-180 type-body text-fg-2">{description}</p>}
        </div>
        {actions != null && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
