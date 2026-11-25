import { useState } from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../Icon/index.ts";
import { IconButton } from "../IconButton/index.ts";
import { Input, type InputProps } from "../Input/index.ts";

export interface PasswordInputProps extends Omit<InputProps, "type" | "suffix"> {
  /**
   * The browser's autofill hint: `"current-password"` to sign in, `"new-password"` to set one.
   * @defaultValue "current-password"
   */
  autoComplete?: string;
}

/**
 * A password Input with a button that shows and hides what was typed. The button is a toggle
 * (`aria-pressed`) labelled "Show password" or "Hide password". Takes every Input prop but `type`
 * and `suffix`.
 *
 * @example
 * <PasswordInput label="Password" required />
 * <PasswordInput label="New password" autoComplete="new-password" hint="At least 12 characters" />
 */
export function PasswordInput({
  autoComplete = "current-password",
  size = "md",
  disabled = false,
  className,
  ...rest
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Input
      {...rest}
      type={revealed ? "text" : "password"}
      autoComplete={autoComplete}
      size={size}
      disabled={disabled}
      className={cn("pr-1", className)}
      suffix={
        <IconButton
          size={size === "lg" ? "md" : "xs"}
          label={revealed ? "Hide password" : "Show password"}
          aria-pressed={revealed}
          disabled={disabled}
          icon={<Icon name={revealed ? "eye-off" : "eye"} size={size === "lg" ? 16 : 14} />}
          onClick={() => setRevealed((value) => !value)}
        />
      }
    />
  );
}
