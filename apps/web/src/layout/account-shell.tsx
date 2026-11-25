import type { Role } from "@not-unreachable/contracts";
import { AppShell, Icon, useToast, type SidebarSection, type TabLinkProps } from "@not-unreachable/design-system";
import { useCallback, useEffect } from "react";
import type * as React from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, api } from "../api/index.ts";
import { useSignedInSession } from "../session/index.ts";

/**
 * Each interface's navigation: only the pages that exist. Kept here, as plain data, so the shared
 * screens (/settings) can show the admin's Sidebar without importing the admin interface.
 */
const sectionsByRole: Record<Role, SidebarSection[]> = {
  admin: [
    {
      title: "Manage",
      items: [
        { id: "files", label: "Files", icon: "files", href: "/admin/files" },
        { id: "share-links", label: "Share links", icon: "share-2", href: "/admin/share-links" },
        { id: "users", label: "Users", icon: "users", href: "/admin/users" },
        { id: "audit-log", label: "Audit log", icon: "scroll-text", href: "/admin/audit-log" },
      ],
    },
    {
      title: "System",
      items: [
        { id: "resources", label: "Resources", icon: "hard-drive", href: "/admin/resources" },
        { id: "settings", label: "Settings", icon: "settings", href: "/admin/settings" },
      ],
    },
  ],
  user: [
    {
      items: [
        { id: "files", label: "Files", icon: "files", href: "/files" },
        { id: "shared", label: "Shared with me", icon: "share-2", href: "/shared" },
      ],
    },
  ],
};

const spaTrees = ["/admin", "/files", "/shared", "/settings"];

function isSpaPath(href: string): boolean {
  return spaTrees.some((tree) => href === tree || href.startsWith(`${tree}/`) || href.startsWith(`${tree}?`));
}

/**
 * The shell's Sidebar and Topbar links are plain anchors: follow the ones to SPA routes with the
 * router instead of reloading the page. Links the router already handles have prevented the default.
 */
function useRouterLinks() {
  const navigate = useNavigate();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (anchor === null || anchor.target !== "" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (href === null || !isSpaPath(href)) return;
      event.preventDefault();
      void navigate(href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [navigate]);
}

/**
 * Signs out and loads /sign-in afresh: a full page load drops everything the account loaded (the
 * query cache, every page's state) at once. Clearing the cached session in place instead would
 * have the current page send the visitor to `/sign-in?next=` before the navigation lands.
 */
export function useSignOut(): () => void {
  const toast = useToast();
  return useCallback(() => {
    void (async () => {
      try {
        await api("signOut");
      } catch (error) {
        // 401: the session had already ended, which is what signing out wanted.
        if (!(error instanceof ApiError && error.status === 401)) {
          toast.show({ tone: "danger", title: "Sign-out did not work", description: "Try again." });
          return;
        }
      }
      window.location.replace("/sign-in");
    })();
  }, [toast]);
}

/** A link tab rendered with the router's Link. */
export function renderRouterLink({ href, children, ...rest }: TabLinkProps): React.ReactNode {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

export interface AccountShellProps {
  /** The navigation item of the current page. */
  readonly activeId?: string | undefined;
  readonly breadcrumbs?: React.ReactNode;
  readonly children?: React.ReactNode;
}

/** The AppShell of the signed-in account's role, with its navigation and account menu. */
export function AccountShell({ activeId, breadcrumbs, children }: AccountShellProps) {
  const { account } = useSignedInSession();
  const navigate = useNavigate();
  const signOut = useSignOut();
  useRouterLinks();

  return (
    <AppShell
      variant={account.role}
      sections={sectionsByRole[account.role]}
      {...(activeId === undefined ? {} : { activeId })}
      breadcrumbs={breadcrumbs}
      account={{
        name: account.displayName,
        items: [
          { heading: account.displayName },
          { label: "Account settings", icon: <Icon name="user" size={14} />, onSelect: () => void navigate("/settings/profile") },
          { divider: true },
          { label: "Sign out", icon: <Icon name="log-out" size={14} />, onSelect: signOut },
        ],
      }}
    >
      {children}
    </AppShell>
  );
}
