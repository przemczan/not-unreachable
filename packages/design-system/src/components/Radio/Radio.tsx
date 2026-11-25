import { useId } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "checked" | "onChange" | "size"> {
  /** Checked, controlled; leave it out (with `defaultChecked`) for an uncontrolled radio. */
  checked?: boolean | undefined;
  /** Called with `true` and the change event when the user selects this radio. */
  onChange?: (checked: boolean, event: React.ChangeEvent<HTMLInputElement>) => void;
  /** The visible label, beside the dot. Without it, give the radio an `aria-label`. */
  label?: React.ReactNode;
  /** Secondary text under the label, linked with `aria-describedby`. */
  description?: React.ReactNode;
  /** @defaultValue false */
  disabled?: boolean | undefined;
  /** Classes for the `<label>` around the dot and its text. */
  className?: string;
  ref?: React.Ref<HTMLInputElement>;
}

/**
 * A single native radio with optional label and description. Radios sharing a `name` form a group
 * with native arrow-key selection; prefer `RadioGroup` for a list of options.
 *
 * @example
 * <Radio name="channel" value="email" label="Email" description="Default" defaultChecked />
 */
export function Radio({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: RadioProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const describedBy = [description != null ? descriptionId : undefined, ariaDescribedBy].filter(Boolean).join(" ");

  return (
    <label
      className={cn(
        "group inline-flex cursor-pointer items-start gap-2 has-disabled:cursor-not-allowed has-disabled:opacity-50",
        className,
      )}
    >
      <span className="relative grid size-4 flex-none place-items-center">
        <input
          type="radio"
          checked={checked}
          disabled={disabled}
          // The label text alone names the control; the wrapping <label> would add the description to the name.
          aria-labelledby={label != null ? labelId : undefined}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          onChange={(event) => onChange?.(event.target.checked, event)}
          className={cn(
            "peer absolute inset-0 m-0 size-4 cursor-pointer appearance-none rounded-full border border-solid border-border-control bg-surface",
            "transition-colors duration-fast ease-out focus-visible:shadow-focus checked:border-accent disabled:cursor-not-allowed",
          )}
          {...rest}
        />
        <span className="pointer-events-none relative hidden size-2 rounded-full bg-accent peer-checked:block" />
      </span>
      {label != null && (
        <span className="flex flex-col">
          <span id={labelId} className="type-label text-fg-1">
            {label}
          </span>
          {description != null && (
            <span id={descriptionId} className="type-caption text-fg-3">
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
}

/** One option of a RadioGroup. */
export interface RadioGroupOption {
  value: string;
  label: React.ReactNode;
  /** Secondary text under the label. */
  description?: React.ReactNode;
  /** @defaultValue false */
  disabled?: boolean;
}

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue" | "role"> {
  /**
   * The options, 2 to 5 mutually exclusive choices.
   * @defaultValue []
   */
  options?: RadioGroupOption[];
  /** The selected value, controlled. */
  value?: string;
  /** The value selected first, uncontrolled. */
  defaultValue?: string;
  /** Called with the value the user selects. */
  onChange?: (value: string) => void;
  /**
   * Lays the options out in a column or a row.
   * @defaultValue "column"
   */
  direction?: "row" | "column";
  /** The group's visible label, naming the `radiogroup`. Without it, give the group an `aria-label`. */
  label?: React.ReactNode;
  /** The `name` the radios share; generated when left out. */
  name?: string;
  /** @defaultValue false */
  disabled?: boolean;
}

/**
 * A `radiogroup` of native radios sharing one `name`: Tab moves into the group, the arrow keys move
 * and select, as the browser does for radios.
 *
 * @example
 * <RadioGroup
 *   label="Notify by"
 *   value={channel}
 *   onChange={setChannel}
 *   options={[{ value: "email", label: "Email", description: "Default" }, { value: "sms", label: "SMS" }]}
 * />
 */
export function RadioGroup({
  options = [],
  value,
  defaultValue,
  onChange,
  direction = "column",
  label,
  name,
  disabled = false,
  className,
  ...rest
}: RadioGroupProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const groupName = name ?? id;

  return (
    <div role="radiogroup" aria-labelledby={label != null ? labelId : undefined} {...rest} className={cn("flex flex-col gap-2", className)}>
      {label != null && (
        <span id={labelId} className="type-label text-fg-1">
          {label}
        </span>
      )}
      <div className={cn("flex", direction === "row" ? "flex-row flex-wrap gap-5" : "flex-col gap-2.5")}>
        {options.map((option) => (
          <Radio
            key={option.value}
            name={groupName}
            value={option.value}
            label={option.label}
            description={option.description}
            disabled={disabled || option.disabled}
            checked={value === undefined ? undefined : value === option.value}
            defaultChecked={value === undefined && defaultValue !== undefined ? defaultValue === option.value : undefined}
            onChange={(checked) => {
              if (checked) onChange?.(option.value);
            }}
          />
        ))}
      </div>
    </div>
  );
}
