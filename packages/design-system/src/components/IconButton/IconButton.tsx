import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const iconButtonVariants = cva(
  [
    "inline-grid flex-none place-items-center rounded-control border border-solid p-0",
    "cursor-pointer transition-colors duration-fast ease-out focus-visible:shadow-focus",
    "disabled:cursor-not-allowed disabled:opacity-45",
  ],
  {
    variants: {
      variant: {
        ghost:
          "border-transparent bg-transparent text-fg-2 enabled:hover:bg-control-hover enabled:hover:text-fg-1 enabled:active:bg-control-press",
        secondary: "border-border-strong bg-surface text-fg-1 enabled:hover:bg-control-hover enabled:active:bg-control-press",
        primary: "border-transparent bg-primary text-primary-fg enabled:hover:bg-primary-hover enabled:active:bg-primary-press",
      },
      size: {
        xs: "size-control-xs",
        sm: "size-control-sm",
        md: "size-control-md",
        lg: "size-control-lg",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The icon, usually `<Icon name="…" />`; it is decorative, `label` names the button. */
  icon: React.ReactNode;
  /** Required accessible label (`aria-label`); also shown as the native `title`. */
  label: string;
  /** @defaultValue "ghost" */
  variant?: "ghost" | "secondary" | "primary";
  /**
   * Square size: `xs` 24px, `sm` 28px, `md` 32px, `lg` 40px.
   * @defaultValue "md"
   */
  size?: "xs" | "sm" | "md" | "lg";
  /** @defaultValue false */
  disabled?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

/**
 * A square, icon-only button for toolbars, row actions and headers. Always give it a `label`.
 *
 * @example
 * <IconButton label="More" icon={<Icon name="more-horizontal" />} />
 */
export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  disabled = false,
  type = "button",
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...rest}
    >
      {icon}
    </button>
  );
}

const iconButtonLinkVariants = cva(
  [
    "inline-grid flex-none place-items-center rounded-control border border-solid p-0 no-underline",
    "cursor-pointer transition-colors duration-fast ease-out focus-visible:shadow-focus",
  ],
  {
    variants: {
      variant: {
        ghost: "border-transparent bg-transparent text-fg-2 hover:bg-control-hover hover:text-fg-1 active:bg-control-press",
        secondary: "border-border-strong bg-surface text-fg-1 hover:bg-control-hover active:bg-control-press",
      },
      size: {
        xs: "size-control-xs",
        sm: "size-control-sm",
        md: "size-control-md",
        lg: "size-control-lg",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export interface IconButtonLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** Where the link goes: a page, or a file the browser downloads (with `download`). */
  href: string;
  /** The icon, usually `<Icon name="…" />`; it is decorative, `label` names the link. */
  icon: React.ReactNode;
  /** Required accessible label (`aria-label`); also shown as the native `title`. */
  label: string;
  /** @defaultValue "ghost" */
  variant?: "ghost" | "secondary";
  /**
   * Square size: `xs` 24px, `sm` 28px, `md` 32px, `lg` 40px.
   * @defaultValue "md"
   */
  size?: "xs" | "sm" | "md" | "lg";
  ref?: React.Ref<HTMLAnchorElement>;
}

/**
 * A plain link that looks like an IconButton, for a row action that is a navigation: a download the
 * browser handles itself (and can resume). Always give it a `label`.
 *
 * @example
 * <IconButtonLink href="/api/v1/home/content?path=report.pdf" download label="Download report.pdf" icon={<Icon name="download" />} />
 */
export function IconButtonLink({ icon, label, variant = "ghost", size = "md", className, ...rest }: IconButtonLinkProps) {
  return (
    <a aria-label={label} title={label} className={cn(iconButtonLinkVariants({ variant, size }), className)} {...rest}>
      {icon}
    </a>
  );
}
