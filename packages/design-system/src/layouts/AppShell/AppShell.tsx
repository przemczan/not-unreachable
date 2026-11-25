import { useState } from "react";
import type * as React from "react";
import { Logo } from "../../brand/index.ts";
import { Avatar } from "../../components/Avatar/index.ts";
import { Icon } from "../../components/Icon/index.ts";
import { IconButton } from "../../components/IconButton/index.ts";
import { Menu, type MenuItem } from "../../components/Menu/index.ts";
import { Sidebar, type SidebarItem, type SidebarSection } from "../../components/Sidebar/index.ts";
import { Topbar } from "../../components/Topbar/index.ts";
import { cn } from "../../lib/index.ts";
import { useTheme } from "./useTheme.ts";

export interface AppShellAccount {
  /** The signed-in person's name: the Avatar's initials and the menu button's name. */
  name: string;
  /** The account menu: profile, sign out… */
  items: MenuItem[];
}

export interface AppShellProps {
  /**
   * `admin`: the Sidebar at the left of the Topbar. `user`: no Sidebar; a user has a single item,
   * Files, so the navigation goes in the Topbar, after the Logo.
   */
  variant: "admin" | "user";
  /** The navigation, in groups: the Sidebar's sections, or for `user` the Topbar's links. */
  sections?: SidebarSection[];
  /** The id of the current page's item. */
  activeId?: string;
  /** Called with an item's id when it is chosen (links navigate as well). */
  onSelect?: (id: string) => void;
  /**
   * `admin` only: shows the Sidebar collapsed to icons. Left out, the shell keeps its own state,
   * which the Topbar's sidebar toggle changes.
   */
  collapsed?: boolean;
  /** `admin` only: called with the new state when the sidebar toggle is pressed. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** The Topbar's left slot, after the sidebar toggle: usually Breadcrumbs. */
  breadcrumbs?: React.ReactNode;
  /** More Topbar utilities, before the theme switch. */
  actions?: React.ReactNode;
  /** The signed-in account: an Avatar button at the Topbar's right that opens its Menu. */
  account?: AppShellAccount;
  /** The page: it opens with a PageHeader. */
  children?: React.ReactNode;
  className?: string;
}

/** The sun/moon IconButton that switches between the light and dark theme and remembers the choice. */
function ThemeSwitch() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return <IconButton label={`Switch to ${next} theme`} icon={<Icon name={theme === "dark" ? "sun" : "moon"} />} onClick={toggleTheme} />;
}

function AccountMenu({ account }: { readonly account: AppShellAccount }) {
  return (
    <Menu
      align="end"
      trigger={<IconButton label={`Account: ${account.name}`} icon={<Avatar name={account.name} size="sm" />} />}
      items={account.items}
    />
  );
}

/** A user's navigation in the Topbar: the same items as an admin's Sidebar, as links or buttons. */
function TopbarNav({
  items,
  activeId,
  onSelect,
}: {
  readonly items: SidebarItem[];
  readonly activeId: string | undefined;
  readonly onSelect: ((id: string) => void) | undefined;
}) {
  return (
    <nav aria-label="Main">
      <ul className="m-0 flex list-none items-center gap-1 p-0">
        {items.map((item) => {
          const active = item.id === activeId;
          const shared = {
            "aria-current": active ? ("page" as const) : undefined,
            onClick: () => onSelect?.(item.id),
            className: cn(
              "flex h-8 cursor-pointer items-center gap-2 rounded-control border-0 px-2.5 type-label no-underline",
              "transition-colors duration-fast ease-out focus-visible:shadow-focus",
              active
                ? "bg-sidebar-active text-sidebar-active-fg hover:text-sidebar-active-fg"
                : "bg-transparent text-fg-2 hover:bg-control-hover hover:text-fg-1",
            ),
          };
          const content = (
            <>
              {item.icon && (
                <span className={cn("grid", active && "text-accent")}>
                  <Icon name={item.icon} size={16} />
                </span>
              )}
              {/* type-label sets the size; the active weight goes on the text, as the font shorthand would override it. */}
              <span className={cn(active && "font-semibold")}>{item.label}</span>
            </>
          );
          return (
            <li key={item.id}>
              {item.href != null ? (
                <a href={item.href} {...shared}>
                  {content}
                </a>
              ) : (
                <button type="button" {...shared}>
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The signed-in app's frame. `admin`: a 240px Sidebar (56px collapsed) and a 56px sticky Topbar with
 * the sidebar toggle, breadcrumbs, the theme switch and the account Menu. `user`: the Topbar alone,
 * with the Logo and the navigation. The content runs to 1440px with the page padding; each page
 * opens with a PageHeader.
 *
 * @example
 * <AppShell
 *   variant="admin"
 *   activeId="users"
 *   sections={[{ items: [{ id: "users", label: "Users", icon: "users", href: "/admin/users" }] }]}
 *   breadcrumbs={<Breadcrumbs items={[{ label: "Users" }]} />}
 *   account={{ name: "Ada Lovelace", items: [{ label: "Sign out" }] }}
 * >
 *   <PageHeader title="Users" />
 * </AppShell>
 */
export function AppShell({
  variant,
  sections = [],
  activeId,
  onSelect,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  breadcrumbs,
  actions,
  account,
  children,
  className,
}: AppShellProps) {
  const [ownCollapsed, setOwnCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? ownCollapsed;
  const admin = variant === "admin";

  const toggleSidebar = () => {
    setOwnCollapsed(!collapsed);
    onCollapsedChange?.(!collapsed);
  };

  const right = (
    <>
      {actions}
      <ThemeSwitch />
      {account && <AccountMenu account={account} />}
    </>
  );

  const content = (
    <main className="flex-1">
      <div className="mx-auto flex w-full max-w-content flex-col gap-5 p-page">{children}</div>
    </main>
  );

  if (!admin) {
    return (
      <div className={cn("flex min-h-screen flex-col bg-bg text-fg-1", className)}>
        <Topbar
          left={
            <>
              <Logo size={22} />
              <TopbarNav items={sections.flatMap((section) => section.items)} activeId={activeId} onSelect={onSelect} />
              {breadcrumbs}
            </>
          }
          right={right}
        />
        {content}
      </div>
    );
  }

  return (
    <div className={cn("flex h-screen bg-bg text-fg-1", className)}>
      <Sidebar
        collapsed={collapsed}
        header={collapsed ? <Logo variant="mark" size={24} /> : <Logo size={22} />}
        sections={sections}
        {...(activeId === undefined ? {} : { activeId })}
        {...(onSelect === undefined ? {} : { onSelect })}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <Topbar
          left={
            <>
              <IconButton
                label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!collapsed}
                icon={<Icon name="panel-left" />}
                onClick={toggleSidebar}
              />
              {breadcrumbs}
            </>
          }
          right={right}
        />
        {content}
      </div>
    </div>
  );
}
