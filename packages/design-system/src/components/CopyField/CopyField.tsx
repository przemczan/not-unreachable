import { useEffect, useId, useState } from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../Icon/index.ts";
import { IconButton } from "../IconButton/index.ts";

/** How long the copy button shows its check mark, in ms. */
const COPIED_FOR = 1500;

export type CopyOutcome = "copied" | "failed";

export interface CopyFieldProps {
  /** The text shown and copied, as text: a command, a link, a code. */
  value: string;
  /** The visible label above the box; it also names the copy button ("Copy command"). */
  label?: string;
  /**
   * What the copy button names when there is no `label`.
   * @defaultValue "text"
   */
  what?: string;
  /** Called after each copy attempt: `copied`, or `failed` when the clipboard refused it. */
  onCopy?: (outcome: CopyOutcome) => void;
  /** Classes for the wrapper. */
  className?: string;
}

/**
 * A read-only value in Geist Mono with a copy button, for a command to run or a link to share. The
 * value wraps anywhere and stays selectable, so it can be copied by hand when the clipboard is
 * refused; the field then says so. A screen may add a Toast through `onCopy`.
 *
 * @example
 * <CopyField label="Command" value="sudo not-unreachable allow-folder /srv/files" onCopy={(outcome) => …} />
 */
export function CopyField({ value, label, what = "text", onCopy, className }: CopyFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);
  const name = (label ?? what).toLowerCase();

  useEffect(() => {
    if (outcome !== "copied") return undefined;
    const timer = setTimeout(() => setOutcome(null), COPIED_FOR);
    return () => clearTimeout(timer);
  }, [outcome]);

  const copy = async () => {
    let result: CopyOutcome;
    try {
      await navigator.clipboard.writeText(value);
      result = "copied";
    } catch {
      result = "failed";
    }
    setOutcome(result);
    onCopy?.(result);
  };

  return (
    <fieldset
      aria-labelledby={label != null ? labelId : undefined}
      className={cn("m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0", className)}
    >
      {label != null && (
        <span id={labelId} className="type-label text-fg-1">
          {label}
        </span>
      )}
      <div className="flex min-w-0 items-start gap-2 rounded-control border border-solid border-border bg-surface-sunken py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 py-0.5 type-mono wrap-anywhere whitespace-pre-wrap text-fg-1">{value}</code>
        <IconButton
          size="xs"
          label={outcome === "copied" ? "Copied" : `Copy ${name}`}
          icon={<Icon name={outcome === "copied" ? "check" : "copy"} size={14} />}
          className={cn(outcome === "copied" && "text-success")}
          onClick={() => void copy()}
        />
      </div>
      <output className={cn(outcome === "failed" ? "type-caption text-danger-fg" : "sr-only")}>
        {outcome === "copied" ? "Copied" : outcome === "failed" ? `Copying did not work. Select the ${name} and copy it by hand.` : ""}
      </output>
    </fieldset>
  );
}
