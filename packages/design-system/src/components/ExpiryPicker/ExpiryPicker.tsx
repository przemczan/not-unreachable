import { useId, useState } from "react";
import { cn } from "../../lib/cn.ts";
import { Input } from "../Input/index.ts";
import { SegmentedControl, type SegmentedOption } from "../SegmentedControl/index.ts";

/** A preset of the ExpiryPicker: a number of days from now, a custom time, or no expiry at all. */
export type ExpiryPreset = "1d" | "7d" | "30d" | "custom" | "never";

const expiryPresets: readonly ExpiryPreset[] = ["1d", "7d", "30d", "custom", "never"];

/** What an ExpiryPicker holds: the preset chosen, and the custom time as typed. */
export interface ExpiryValue {
  preset: ExpiryPreset;
  /** The custom time, as a `datetime-local` value in the browser's local time ("2026-12-01T14:00"); "" when none. */
  custom: string;
}

/** The default: 7 days from now. */
export const defaultExpiryValue: ExpiryValue = { preset: "7d", custom: "" };

const DAY_MS = 24 * 60 * 60 * 1000;
const presetDays: Partial<Record<ExpiryPreset, number>> = { "1d": 1, "7d": 7, "30d": 30 };

const pad = (value: number): string => String(value).padStart(2, "0");

/** A time as a `datetime-local` value, in the browser's local time, to the minute. */
export function toLocalDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The time an ExpiryPicker's value stands for: a Date, `null` for "No expiry", or `undefined`
 * while the custom time is empty or not a valid time.
 */
export function expiryDateOf(value: ExpiryValue, now: Date = new Date()): Date | null | undefined {
  if (value.preset === "never") return null;
  const days = presetDays[value.preset];
  if (days !== undefined) return new Date(now.getTime() + days * DAY_MS);
  if (value.custom === "") return undefined;
  const date = new Date(value.custom);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export interface ExpiryPickerProps {
  /** The value, controlled. */
  value?: ExpiryValue;
  /**
   * The value first chosen, uncontrolled.
   * @defaultValue defaultExpiryValue (7 days)
   */
  defaultValue?: ExpiryValue;
  /** Called with the new value on every change. */
  onChange?: (value: ExpiryValue) => void;
  /**
   * The visible label of the presets.
   * @defaultValue "Expires"
   */
  label?: string;
  /**
   * Offers "No expiry" as a last preset. The screen should warn when it is chosen.
   * @defaultValue true
   */
  allowNever?: boolean;
  /** An error for the custom time: turns its border red and replaces the hint. */
  error?: string;
  /** "Now", for the hint and the custom time's lower bound; the current time when left out. */
  now?: Date;
  className?: string;
}

/**
 * When something stops working, such as a share link: SegmentedControl presets "1 day / 7 days /
 * 30 days / Custom / No expiry", and a native `datetime-local` Input for a custom time. A line
 * under it says when the chosen preset expires. Read the chosen time with `expiryDateOf(value)`.
 *
 * @example
 * const [expiry, setExpiry] = useState(defaultExpiryValue);
 * <ExpiryPicker value={expiry} onChange={setExpiry} />
 * expiryDateOf(expiry) // Date, null for "No expiry", undefined while the custom time is empty
 */
export function ExpiryPicker({
  value,
  defaultValue = defaultExpiryValue,
  onChange,
  label = "Expires",
  allowNever = true,
  error,
  now,
  className,
}: ExpiryPickerProps) {
  const hintId = `${useId()}-hint`;
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  // "Now" as the picker first rendered: the presets' hint and the custom time's lower bound.
  const [openedAt] = useState(() => new Date());
  const current = value ?? uncontrolled;
  const at = now ?? openedAt;

  const change = (next: ExpiryValue) => {
    setUncontrolled(next);
    onChange?.(next);
  };

  const options: SegmentedOption[] = [
    { value: "1d", label: "1 day" },
    { value: "7d", label: "7 days" },
    { value: "30d", label: "30 days" },
    { value: "custom", label: "Custom" },
    ...(allowNever ? [{ value: "never", label: "No expiry" }] : []),
  ];

  const selectPreset = (selected: string) => {
    const preset = expiryPresets.find((candidate) => candidate === selected);
    if (preset === undefined) return;
    // A custom time starts from the preset chosen before, so it only needs adjusting.
    const previous = expiryDateOf(current, at) ?? new Date(at.getTime() + 7 * DAY_MS);
    const custom = preset === "custom" && current.custom === "" ? toLocalDateTimeInput(previous) : current.custom;
    change({ preset, custom });
  };

  const date = expiryDateOf(current, at);
  const hint =
    current.preset === "never"
      ? "It never expires."
      : current.preset === "custom"
        ? undefined
        : date == null
          ? undefined
          : `Expires ${absolute.format(date)}.`;

  return (
    <fieldset className={cn("m-0 min-w-0 border-0 p-0", className)}>
      <legend className="mb-1.5 p-0 type-label text-fg-1">{label}</legend>
      <div className="flex min-w-0 flex-col gap-1.5">
        <SegmentedControl
          aria-label={label}
          aria-describedby={hint === undefined ? undefined : hintId}
          options={options}
          value={current.preset}
          onChange={selectPreset}
          className="self-start"
        />
        {current.preset === "custom" && (
          <Input
            label="Expiry date and time"
            type="datetime-local"
            className="w-60"
            min={toLocalDateTimeInput(at)}
            value={current.custom}
            onChange={(event) => change({ preset: "custom", custom: event.target.value })}
            {...(error === undefined ? { hint: "In your local time." } : { error })}
          />
        )}
        {hint !== undefined && (
          <p id={hintId} className="m-0 type-caption text-fg-3">
            {hint}
          </p>
        )}
      </div>
    </fieldset>
  );
}
