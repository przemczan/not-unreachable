import { useEffect, useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { toCssLength } from "../../lib/toCssLength.ts";
import { Icon } from "../Icon/index.ts";

const columnClasses = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" } as const;

/** How long the copy button shows its check mark, in ms. */
const COPIED_FOR = 1200;

export interface DescriptionItem {
  label: React.ReactNode;
  /** The value, as text; "—" when left out. */
  value?: React.ReactNode;
  /** Geist Mono: IDs, IP addresses, codes. */
  mono?: boolean;
  /** Adds a copy button: `true` copies `value` (when it is text), a string copies that string. */
  copyable?: boolean | string;
}

export interface DescriptionListProps {
  /** @defaultValue [] */
  items?: DescriptionItem[];
  /**
   * `inline`: label column and value, with dividers (details, drawers); `stacked`: label above value.
   * @defaultValue "inline"
   */
  layout?: "inline" | "stacked";
  /**
   * Columns of pairs.
   * @defaultValue 1
   */
  columns?: 1 | 2 | 3;
  /**
   * The label column's width in px, for `inline`.
   * @defaultValue 160
   */
  labelWidth?: number;
  className?: string;
}

function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_FOR);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      title={copied ? "Copied" : "Copy"}
      onClick={() => void copy().catch(() => undefined)}
      className={cn(
        "ml-1.5 inline-grid cursor-pointer place-items-center rounded-badge border-0 bg-transparent p-0.5 align-middle focus-visible:shadow-focus",
        copied ? "text-success" : "text-fg-3 hover:text-fg-1",
      )}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

function copyTextOf(item: DescriptionItem): string | undefined {
  if (typeof item.copyable === "string") return item.copyable;
  if (item.copyable !== true) return undefined;
  return typeof item.value === "string" || typeof item.value === "number" ? String(item.value) : undefined;
}

function Value({ item, className }: { readonly item: DescriptionItem; readonly className?: string }) {
  const copyText = copyTextOf(item);
  return (
    <dd className={cn("m-0 min-w-0 wrap-anywhere text-fg-1", item.mono ? "type-mono" : "type-body", className)}>
      {item.value ?? "—"}
      {copyText !== undefined && <CopyButton text={copyText} />}
    </dd>
  );
}

/**
 * Label–value pairs for a record's fields: the event in the audit log's Drawer, a user's details.
 * Values are text; an empty one shows "—". A `copyable` value gets a copy button.
 *
 * @example
 * <DescriptionList labelWidth={96} items={[
 *   { label: "Event", value: "session.signed_out", mono: true },
 *   { label: "Event ID", value: "evt_10482", mono: true, copyable: true },
 *   { label: "IP address", value: "10.0.0.4", mono: true },
 * ]} />
 */
export function DescriptionList({ items = [], layout = "inline", columns = 1, labelWidth = 160, className }: DescriptionListProps) {
  if (layout === "stacked") {
    return (
      <dl className={cn("m-0 grid gap-x-6 gap-y-4", columnClasses[columns], className)}>
        {items.map((item, index) => (
          <div key={index} className="min-w-0">
            <dt className="mb-1 type-caption text-fg-3">{item.label}</dt>
            <Value item={item} />
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl style={{ "--nu-dl-label": toCssLength(labelWidth) }} className={cn("m-0 grid gap-x-8", columnClasses[columns], className)}>
      {items.map((item, index) => (
        <div key={index} className="flex items-baseline gap-4 border-b border-solid border-border-subtle py-2.5">
          <dt className="w-(--nu-dl-label) flex-none type-body-sm text-fg-3">{item.label}</dt>
          <Value item={item} className="flex-1" />
        </div>
      ))}
    </dl>
  );
}
