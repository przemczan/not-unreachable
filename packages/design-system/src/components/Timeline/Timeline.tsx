import { useId } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon, type IconName } from "../Icon/index.ts";

const nodeTone = {
  neutral: "bg-surface-sunken text-fg-2",
  accent: "bg-accent-subtle text-accent-subtle-fg",
  success: "bg-success-subtle text-success-fg",
  warning: "bg-warning-subtle text-warning-fg",
  danger: "bg-danger-subtle text-danger-fg",
  info: "bg-info-subtle text-info-fg",
} as const;

export interface TimelineItem {
  /** The React key; the index when left out. */
  id?: string | number;
  /** A bold lead-in, such as "Ada Lovelace" or "System". */
  actor?: React.ReactNode;
  /** The event, after the actor: "signed out a session". */
  title: React.ReactNode;
  /** A line under the title. */
  description?: React.ReactNode;
  /** Pre-formatted time, such as "14:02" or "2h ago". */
  time?: React.ReactNode;
  /** The machine-readable time (ISO 8601), which makes `time` a `<time>` element. */
  dateTime?: string;
  /**
   * The icon in the node; ignored when `avatar` is given.
   * @defaultValue "circle-dot"
   */
  icon?: IconName;
  /** An Avatar in place of the icon. */
  avatar?: React.ReactNode;
  /**
   * The node's colour: `danger` for failures, `success`, `warning`, `info`, `accent`, `neutral`.
   * @defaultValue "neutral"
   */
  tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
  /** An extra block under the text: Badges, a diff. */
  meta?: React.ReactNode;
  /** A control at the right of the row, such as a "Details" Button. */
  action?: React.ReactNode;
}

/** A day (or any heading) and its events. */
export interface TimelineGroup {
  /** The React key; the heading's index when left out. */
  id?: string | number;
  /** The day: "Today", "20 Oct 2026". */
  heading: React.ReactNode;
  /** A note after the heading, such as "12 events". */
  description?: React.ReactNode;
  items: TimelineItem[];
}

export interface TimelineProps {
  /** One ungrouped list of events, newest first. Ignored when `groups` is given. */
  items?: TimelineItem[];
  /** Events grouped under day headings (the audit log), newest first. */
  groups?: TimelineGroup[];
  className?: string;
}

function TimelineList({ items }: { readonly items: TimelineItem[] }) {
  return (
    <ol className="m-0 list-none p-0">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <li key={item.id ?? index} className="relative flex gap-3">
            <div className="relative flex w-7 flex-none justify-center">
              {!last && <span aria-hidden="true" className="absolute top-7 bottom-0 w-px bg-border" />}
              <span
                aria-hidden="true"
                className={cn(
                  "relative grid size-7 place-items-center rounded-full border border-solid border-surface ring-1 ring-border",
                  nodeTone[item.tone ?? "neutral"],
                )}
              >
                {item.avatar ?? <Icon name={item.icon ?? "circle-dot"} size={14} />}
              </span>
            </div>
            <div className={cn("min-w-0 flex-1", !last && "pb-5")}>
              <div className="flex min-h-7 items-baseline justify-between gap-3 pt-1">
                <div className="min-w-0 type-body text-fg-2">
                  {item.actor != null && (
                    <>
                      <strong className="font-semibold text-fg-1">{item.actor}</strong>{" "}
                    </>
                  )}
                  {item.title}
                </div>
                <div className="flex flex-none items-baseline gap-3">
                  {item.time != null &&
                    (item.dateTime != null ? (
                      <time dateTime={item.dateTime} className="whitespace-nowrap type-mono text-fg-3">
                        {item.time}
                      </time>
                    ) : (
                      <span className="whitespace-nowrap type-mono text-fg-3">{item.time}</span>
                    ))}
                  {item.action}
                </div>
              </div>
              {item.description != null && <div className="mt-0.5 type-body-sm text-fg-3">{item.description}</div>}
              {item.meta != null && <div className="mt-2">{item.meta}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TimelineSection({ group }: { readonly group: TimelineGroup }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2 border-b border-solid border-border pb-2">
        <h3 id={headingId} className="m-0 type-card-title text-fg-1">
          {group.heading}
        </h3>
        {group.description != null && <span className="type-body-sm text-fg-3">{group.description}</span>}
      </div>
      <TimelineList items={group.items} />
    </section>
  );
}

/**
 * A vertical list of events, newest first: a tinted node per event on a hairline, the actor in
 * bold, the time in mono at the right. With `groups`, each day gets a heading (an `h3` naming its
 * section) above its events, as in the audit log.
 *
 * @example
 * <Timeline groups={[{ heading: "Today", description: "2 events", items: [
 *   { id: "evt_2", actor: "Ada Lovelace", title: "signed in", time: "14:02", dateTime: "2026-10-20T14:02:00Z",
 *     icon: "log-in", tone: "success", action: <Button size="sm" variant="ghost" onClick={open}>Details</Button> },
 * ] }]} />
 */
export function Timeline({ items = [], groups, className }: TimelineProps) {
  if (groups !== undefined) {
    return (
      <div className={cn("flex flex-col gap-6", className)}>
        {groups.map((group, index) => (
          <TimelineSection key={group.id ?? index} group={group} />
        ))}
      </div>
    );
  }
  return (
    <div className={className}>
      <TimelineList items={items} />
    </div>
  );
}
