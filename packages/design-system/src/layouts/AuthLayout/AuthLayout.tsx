import { useId } from "react";
import type * as React from "react";
import { Logo } from "../../brand/index.ts";
import { cn } from "../../lib/index.ts";

export interface AuthLayoutProps {
  /** The card's heading, the page's `h1`, such as "Sign in". */
  title?: React.ReactNode;
  /** One line under the title. */
  description?: React.ReactNode;
  /** A caption under the card, such as "Every sign-in is logged." */
  footer?: React.ReactNode;
  /** The card's content: usually a form. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * The frame of the signed-out screens (sign-in, second factor, setup, invitation, password reset):
 * a centred 380px column on the page background with the Logo above a raised card and a caption
 * below. Its accent Button is the screen's one ember-filled moment.
 *
 * @example
 * <AuthLayout title="Sign in" description="Use your NotUnreachable account." footer="Every sign-in is logged.">
 *   <form>…</form>
 * </AuthLayout>
 */
export function AuthLayout({ title, description, footer, children, className }: AuthLayoutProps) {
  const titleId = useId();
  return (
    <main className={cn("grid min-h-screen place-items-center bg-bg p-6 text-fg-1", className)}>
      <div className="flex w-full max-w-95 flex-col gap-6">
        <div className="flex justify-center">
          <Logo size={28} />
        </div>
        <section
          aria-labelledby={title != null ? titleId : undefined}
          className="flex flex-col gap-4 rounded-dialog border border-solid border-border bg-surface p-7 shadow-raised"
        >
          {(title != null || description != null) && (
            <div className="flex flex-col gap-1">
              {title != null && (
                <h1 id={titleId} className="m-0 type-section-title text-fg-1">
                  {title}
                </h1>
              )}
              {description != null && <p className="m-0 type-body-sm text-fg-3">{description}</p>}
            </div>
          )}
          {children}
        </section>
        {footer != null && <p className="m-0 text-center type-caption text-fg-3">{footer}</p>}
      </div>
    </main>
  );
}
