import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../Icon/index.ts";
import type { IconName } from "../Icon/index.ts";

export interface SidebarItem {
  /** Unique id: compared with `activeId` and passed to `onSelect`. */
  id: string;
  label: string;
  /** Lucide icon name, one of the curated `icons`. */
  icon?: IconName;
  /** A count shown as a mono chip, such as the number of users. */
  badge?: React.ReactNode;
  /** With it the item is a link (`aria-current="page"` when active); without it, a button. */
  href?: string;
}

export interface SidebarSection {
  /** A small overline heading above the section's items; hidden while collapsed. */
  title?: string;
  items: SidebarItem[];
}

export interface SidebarProps {
  /** The top strip, as tall as the Topbar: usually the Logo. */
  header?: React.ReactNode;
  /** The navigation, in groups. */
  sections?: SidebarSection[];
  /** The id of the current page's item. */
  activeId?: string;
  /** Called with an item's id when it is chosen (links navigate as well). */
  onSelect?: (id: string) => void;
  /** The bottom strip: usually the signed-in user. */
  footer?: React.ReactNode;
  /**
   * Icons only, 56px wide; each item is then named by its label.
   * @defaultValue false
   */
  collapsed?: boolean;
  className?: string;
}

const itemVariants = cva(
  [
    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-control border-0 text-left type-label no-underline",
    "transition-colors duration-fast ease-out focus-visible:shadow-focus",
  ],
  {
    variants: {
      active: {
        true: "bg-sidebar-active text-sidebar-active-fg hover:text-sidebar-active-fg",
        false: "bg-transparent text-sidebar-fg hover:bg-control-hover hover:text-sidebar-fg",
      },
      collapsed: {
        true: "justify-center p-0",
        false: "justify-start px-2.5",
      },
    },
  },
);

interface SidebarNavItemProps {
  readonly item: SidebarItem;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly onSelect?: ((id: string) => void) | undefined;
}

/** One navigation entry: a link when it has an `href`, else a button. */
function SidebarNavItem({ item, active, collapsed, onSelect }: SidebarNavItemProps) {
  const shared = {
    "aria-current": active ? ("page" as const) : undefined,
    "aria-label": collapsed ? item.label : undefined,
    title: collapsed ? item.label : undefined,
    onClick: () => onSelect?.(item.id),
    className: itemVariants({ active, collapsed }),
  };
  const content = (
    <>
      {item.icon && (
        <span className={cn("grid", active && "text-accent")}>
          <Icon name={item.icon} size={16} />
        </span>
      )}
      {!collapsed && (
        // type-label sets the size; the active weight goes on the text, as the font shorthand would override it.
        <span className={cn("min-w-0 flex-1 truncate", active && "font-semibold")}>{item.label}</span>
      )}
      {!collapsed && item.badge != null && (
        <span
          className={cn(
            "rounded-badge border border-solid border-border px-1.5 py-0.75 type-overline text-fg-2",
            active ? "bg-surface" : "bg-surface-sunken",
          )}
        >
          {item.badge}
        </span>
      )}
    </>
  );
  return item.href != null ? (
    <a href={item.href} {...shared}>
      {content}
    </a>
  ) : (
    <button type="button" {...shared}>
      {content}
    </button>
  );
}

/**
 * The app's navigation rail: a header with the logo, grouped items, a footer with the user. 240px
 * wide, 56px collapsed; the active item gets a tinted fill and an ember icon.
 *
 * @example
 * <Sidebar
 *   header={<Logo />}
 *   activeId="users"
 *   onSelect={go}
 *   sections={[
 *     { items: [{ id: "overview", label: "Overview", icon: "layout-dashboard", href: "/" }] },
 *     { title: "Manage", items: [{ id: "users", label: "Users", icon: "users", badge: 1284, href: "/users" }] },
 *   ]}
 *   footer={<UserChip />}
 * />
 */
export function Sidebar({ header, sections = [], activeId, onSelect, footer, collapsed = false, className }: SidebarProps) {
  return (
    <nav
      aria-label="Main"
      className={cn(
        "flex h-full flex-none flex-col overflow-hidden border-r border-solid border-border bg-sidebar transition-all duration-base ease-out",
        collapsed ? "w-sidebar-collapsed" : "w-sidebar",
        className,
      )}
    >
      {header != null && (
        <div
          className={cn(
            "flex h-topbar flex-none items-center border-b border-solid border-border",
            collapsed ? "justify-center" : "justify-start px-4",
          )}
        >
          {header}
        </div>
      )}
      <div className={cn("flex flex-1 flex-col gap-4 overflow-y-auto py-3", collapsed ? "px-2" : "px-2.5")}>
        {sections.map((section, index) => (
          <div key={index} className="flex flex-col">
            {section.title && !collapsed && (
              <div aria-hidden="true" className="px-2.5 pt-1 pb-1.5 type-overline text-fg-3">
                {section.title}
              </div>
            )}
            <ul aria-label={section.title} className="m-0 flex list-none flex-col gap-0.5 p-0">
              {section.items.map((item) => (
                <li key={item.id}>
                  <SidebarNavItem item={item} active={item.id === activeId} collapsed={collapsed} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {footer != null && <div className={cn("flex-none border-t border-solid border-border", collapsed ? "p-2" : "p-2.5")}>{footer}</div>}
    </nav>
  );
}
