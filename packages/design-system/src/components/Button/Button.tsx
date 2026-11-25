import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../Icon/index.ts";

const buttonVariants = cva(
  [
    "inline-flex flex-none items-center justify-center whitespace-nowrap rounded-control border border-solid font-sans",
    "cursor-pointer transition duration-fast ease-out enabled:active:translate-y-px focus-visible:shadow-focus",
    "disabled:cursor-not-allowed disabled:not-aria-busy:opacity-45",
  ],
  {
    variants: {
      variant: {
        primary: "border-transparent bg-primary text-primary-fg enabled:hover:bg-primary-hover enabled:active:bg-primary-press",
        accent:
          "border-transparent bg-accent-fill text-fg-on-accent enabled:hover:bg-accent-fill-hover enabled:active:bg-accent-fill-press",
        secondary:
          "border-border-strong bg-surface text-fg-1 shadow-control enabled:hover:bg-control-hover enabled:active:bg-control-press",
        ghost: "border-transparent bg-transparent text-fg-1 enabled:hover:bg-control-hover enabled:active:bg-control-press",
        danger: "border-transparent bg-danger text-fg-on-accent enabled:hover:bg-danger-hover enabled:active:bg-danger-press",
        "danger-ghost": "border-transparent bg-transparent text-danger-fg enabled:hover:bg-danger-subtle enabled:active:bg-danger-subtle",
      },
      size: {
        sm: "h-control-sm gap-1.5 px-2.5 type-label",
        md: "h-control-md gap-1.5 px-3 type-label",
        lg: "h-control-lg gap-2 px-4 type-body",
      },
      fullWidth: {
        true: "flex w-full",
        false: "",
      },
    },
    defaultVariants: { variant: "primary", size: "md", fullWidth: false },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` = ink fill, the one main action of a view; `accent` = ember fill, only for brand
   * moments such as sign-in; `secondary` = bordered surface, for everything else in toolbars;
   * `ghost`; `danger` = destructive fill; `danger-ghost`.
   * @defaultValue "primary"
   */
  variant?: "primary" | "accent" | "secondary" | "ghost" | "danger" | "danger-ghost";
  /**
   * Height: `sm` 28px, `md` 32px, `lg` 40px.
   * @defaultValue "md"
   */
  size?: "sm" | "md" | "lg";
  /** Shown before the label, usually `<Icon size={14} />`. Replaced by the spinner while `loading`. */
  iconLeft?: React.ReactNode;
  /** Shown after the label. */
  iconRight?: React.ReactNode;
  /**
   * Shows a spinner, sets `aria-busy` and disables the button until the work is done.
   * @defaultValue false
   */
  loading?: boolean;
  /** @defaultValue false */
  disabled?: boolean;
  /**
   * Stretches the button to the width of its container.
   * @defaultValue false
   */
  fullWidth?: boolean;
  children?: React.ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
}

/**
 * The action control. One `primary` per view; `accent` only for brand moments like sign-in.
 *
 * @example
 * <Button iconLeft={<Icon name="plus" size={14} />}>New user</Button>
 * <Button variant="secondary">Export</Button>
 */
export function Button({
  variant = "primary",
  size = "md",
  iconLeft,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, fullWidth }), className)}
      {...rest}
    >
      {loading ? <Icon name="loader-circle" size={size === "lg" ? 16 : 14} className="animate-spin" /> : iconLeft}
      {/* lg is 14px medium: type-body sets the size, the weight goes on the label (a type-* font shorthand would override it). */}
      {children != null && <span className={size === "lg" ? "font-medium" : undefined}>{children}</span>}
      {iconRight}
    </button>
  );
}

const buttonLinkVariants = cva(
  [
    "inline-flex flex-none items-center justify-center whitespace-nowrap rounded-control border border-solid font-sans no-underline",
    "cursor-pointer transition duration-fast ease-out active:translate-y-px focus-visible:shadow-focus",
  ],
  {
    variants: {
      variant: {
        primary: "border-transparent bg-primary text-primary-fg hover:bg-primary-hover active:bg-primary-press",
        secondary: "border-border-strong bg-surface text-fg-1 shadow-control hover:bg-control-hover active:bg-control-press",
      },
      size: {
        sm: "h-control-sm gap-1.5 px-2.5 type-label",
        md: "h-control-md gap-1.5 px-3 type-label",
        lg: "h-control-lg gap-2 px-4 type-body",
      },
      fullWidth: {
        true: "flex w-full",
        false: "",
      },
    },
    defaultVariants: { variant: "primary", size: "md", fullWidth: false },
  },
);

export interface ButtonLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** Where the link goes: a page, or a file the browser downloads (with `download`). */
  href: string;
  /**
   * `primary` = ink fill, the one main action of a view; `secondary` = bordered surface.
   * @defaultValue "primary"
   */
  variant?: "primary" | "secondary";
  /**
   * Height: `sm` 28px, `md` 32px, `lg` 40px.
   * @defaultValue "md"
   */
  size?: "sm" | "md" | "lg";
  /** Shown before the label, usually `<Icon size={14} />`. */
  iconLeft?: React.ReactNode;
  /**
   * Stretches the link to the width of its container.
   * @defaultValue false
   */
  fullWidth?: boolean;
  children?: React.ReactNode;
  ref?: React.Ref<HTMLAnchorElement>;
}

/**
 * A plain link that looks like a Button, for an action that is a navigation: a download the
 * browser handles itself (and can resume), or a page to go to.
 *
 * @example
 * <ButtonLink href="/api/v1/public/share-links/…/content" download iconLeft={<Icon name="download" size={14} />}>Download</ButtonLink>
 */
export function ButtonLink({
  variant = "primary",
  size = "md",
  iconLeft,
  fullWidth = false,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <a className={cn(buttonLinkVariants({ variant, size, fullWidth }), className)} {...rest}>
      {iconLeft}
      {children != null && <span className={size === "lg" ? "font-medium" : undefined}>{children}</span>}
    </a>
  );
}
