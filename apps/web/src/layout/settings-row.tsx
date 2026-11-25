import type * as React from "react";

export interface SettingsRowProps {
  /** The setting's name; it labels the control with `htmlFor`. */
  readonly label: string;
  /** The control's `id`; left out for a row that only shows a value, whose name is then plain text. */
  readonly htmlFor?: string;
  /** What the setting does, under the label. */
  readonly description?: React.ReactNode;
  /** The control. */
  readonly children?: React.ReactNode;
}

/** One row of a settings page: the label and its description at the left, the control at the right. */
export function SettingsRow({ label, htmlFor, description, children }: SettingsRowProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-solid border-border-subtle py-4 last:border-b-0 md:flex-row md:items-start md:gap-8">
      <div className="flex flex-col gap-0.5 md:w-80 md:flex-none">
        {htmlFor === undefined ? (
          <span className="type-label text-fg-1">{label}</span>
        ) : (
          <label htmlFor={htmlFor} className="type-label text-fg-1">
            {label}
          </label>
        )}
        {description != null && <p className="m-0 type-body-sm text-fg-3">{description}</p>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
