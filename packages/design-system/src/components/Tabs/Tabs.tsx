import { Fragment, useId, useRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const tabClasses = [
  "-mb-px inline-flex h-9.5 flex-none cursor-pointer items-center gap-1.5 whitespace-nowrap border-0 border-b-2 border-solid border-transparent bg-transparent p-0",
  "type-label text-fg-3 no-underline transition-colors duration-fast ease-out hover:text-fg-1 focus-visible:shadow-focus",
  "disabled:cursor-not-allowed disabled:text-fg-disabled",
].join(" ");

const activeTabClasses = "border-accent font-semibold text-fg-1";

/** One tab of Tabs. */
export interface TabItem {
  value: string;
  label: React.ReactNode;
  /** A small count after the label, such as pending invitations. */
  count?: number;
  /** With it the tab is a link to a route (all tabs then should have one): see Tabs. */
  href?: string;
  /** Shown, but not selectable. */
  disabled?: boolean;
}

/** What `renderLink` gets for a link tab: spread it on the router's link. */
export interface TabLinkProps {
  href: string;
  className: string;
  "aria-current": "page" | undefined;
  children: React.ReactNode;
}

export interface TabsProps {
  /**
   * The tabs: plain strings (value and label alike) or `{ value, label, count, href, disabled }`.
   * @defaultValue []
   */
  tabs?: (string | TabItem)[];
  /** The selected tab's value; for link tabs, the current route's tab. */
  value?: string;
  /** Called with the value of the in-page tab the user selects. Link tabs navigate instead: derive `value` from the route. */
  onChange?: (value: string) => void;
  /**
   * Base id for the tabs and their panels: with it, each tab controls the TabPanel given the same
   * `tabsId` and its value (`aria-controls`). Without it the tabs get generated ids and no `aria-controls`.
   */
  id?: string;
  /** Names the tab list, or the link tabs' navigation landmark, such as "Settings sections". */
  "aria-label"?: string;
  /**
   * Renders a link tab with the app's router link instead of a plain `<a>`; spread the props it
   * gets (map `href` to the router's prop).
   */
  renderLink?: (props: TabLinkProps) => React.ReactNode;
  className?: string;
}

function tabIds(base: string, value: string) {
  // A value may hold spaces ("Sign-in providers"), which an id can't.
  const slug = value.replaceAll(/[^\w-]/g, "-");
  return { tab: `${base}-tab-${slug}`, panel: `${base}-panel-${slug}` };
}

function normalize(tab: string | TabItem): TabItem {
  return typeof tab === "string" ? { value: tab, label: tab } : tab;
}

function TabLabel({ item }: { readonly item: TabItem }) {
  return (
    <>
      {item.label}
      {item.count != null && (
        <span className="rounded-badge border border-solid border-border bg-surface-sunken px-1.25 py-0.5 type-overline text-fg-2 tabular-nums">
          {item.count}
        </span>
      )}
    </>
  );
}

function defaultLink({ children, ...props }: TabLinkProps) {
  return <a {...props}>{children}</a>;
}

/**
 * The tab strip under a PageHeader: an ember underline marks the active tab.
 *
 * Two kinds, chosen by the items:
 * - **In-page tabs** (no `href`): a WAI-ARIA `tablist` of `tab` buttons. Tab reaches the selected
 *   tab; the arrow keys, Home and End move between tabs and select them. Put each panel in a
 *   `TabPanel` with the same `tabsId` (and give Tabs that `id`).
 * - **Link tabs** (every item has an `href`): a `nav` of links, the current one `aria-current="page"`,
 *   for sections that are routes (`/settings/profile`, `/settings/sessions`). Pass `renderLink` to
 *   use the router's link.
 *
 * @example
 * <Tabs id="admin-settings" aria-label="Settings sections" tabs={["General", "Security"]} value={tab} onChange={setTab} />
 * <TabPanel tabsId="admin-settings" value="Security">…</TabPanel>
 *
 * <Tabs aria-label="Account" value="sessions" renderLink={({ href, ...rest }) => <Link to={href} {...rest} />}
 *   tabs={[{ value: "profile", label: "Profile", href: "/settings/profile" }, { value: "sessions", label: "Sessions", href: "/settings/sessions" }]} />
 */
export function Tabs({ tabs = [], value, onChange, id, "aria-label": ariaLabel, renderLink = defaultLink, className }: TabsProps) {
  const generatedId = useId();
  const base = id ?? generatedId;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const items = tabs.map(normalize);
  const stripClasses = cn("flex gap-5 overflow-x-auto overflow-y-hidden border-b border-solid border-border", className);

  if (items.length > 0 && items.every((item) => item.href != null)) {
    return (
      <nav aria-label={ariaLabel} className={stripClasses}>
        {items.map((item) => {
          const active = item.value === value;
          return (
            <Fragment key={item.value}>
              {renderLink({
                href: item.href ?? "",
                "aria-current": active ? "page" : undefined,
                className: cn(tabClasses, active && activeTabClasses),
                children: <TabLabel item={item} />,
              })}
            </Fragment>
          );
        })}
      </nav>
    );
  }

  const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index !== -1);
  const selectedIndex = items.findIndex((item) => item.value === value && !item.disabled);
  const focusableIndex = selectedIndex === -1 ? (enabled[0] ?? -1) : selectedIndex;

  const select = (index: number) => {
    const item = items[index];
    if (item === undefined) return;
    buttons.current[index]?.focus();
    if (item.value !== value) onChange?.(item.value);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const position = enabled.indexOf(index);
    const last = enabled.length - 1;
    const targets: Partial<Record<string, number>> = {
      ArrowLeft: position <= 0 ? last : position - 1,
      ArrowRight: position === last ? 0 : position + 1,
      Home: 0,
      End: last,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(enabled[target] ?? index);
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className={stripClasses}>
      {items.map((item, index) => {
        const active = index === selectedIndex;
        const ids = tabIds(base, item.value);
        return (
          <button
            key={item.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="tab"
            id={ids.tab}
            aria-selected={active}
            aria-controls={id != null ? ids.panel : undefined}
            tabIndex={index === focusableIndex ? 0 : -1}
            disabled={item.disabled}
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(tabClasses, active && activeTabClasses)}
          >
            <TabLabel item={item} />
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "id" | "role"> {
  /** The `id` given to the Tabs this panel belongs to. */
  tabsId: string;
  /** The value of the tab that shows this panel. */
  value: string;
  children?: React.ReactNode;
}

/**
 * The content of one in-page tab: a `tabpanel` labelled by its tab. Render only the selected tab's
 * panel.
 */
export function TabPanel({ tabsId, value, children, ...rest }: TabPanelProps) {
  const ids = tabIds(tabsId, value);
  return (
    // Focusable, so keyboard users reach a panel with no focusable content first (WAI-ARIA tabs pattern).
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} tabIndex={0} {...rest}>
      {children}
    </div>
  );
}
