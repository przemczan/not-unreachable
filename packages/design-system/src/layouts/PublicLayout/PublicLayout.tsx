import type * as React from "react";
import { Logo } from "../../brand/index.ts";
import { Topbar } from "../../components/Topbar/index.ts";
import { cn } from "../../lib/index.ts";

export interface PublicLayoutProps {
  /** The page, centred under the Topbar. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * The frame of the pages anyone with a link can open, such as a share link: a Topbar with only the
 * Logo, and the content centred below it.
 *
 * @example
 * <PublicLayout>
 *   <Card title="report.pdf">…</Card>
 * </PublicLayout>
 */
export function PublicLayout({ children, className }: PublicLayoutProps) {
  return (
    <div className={cn("flex min-h-screen flex-col bg-bg text-fg-1", className)}>
      <Topbar left={<Logo size={22} />} />
      <main className="flex flex-1 justify-center p-page">
        <div className="flex w-full max-w-content flex-col items-center gap-5">{children}</div>
      </main>
    </div>
  );
}
