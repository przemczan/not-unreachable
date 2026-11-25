import { cn } from "../../lib/cn.ts";

export interface BreadcrumbItem {
  label: string;
  /** Where the crumb links to; `"#"` when left out. */
  href?: string;
  /** Called instead of following the link (client-side navigation). */
  onClick?: () => void;
}

export interface BreadcrumbsProps {
  /** The trail, from the top level down; the last one is the current page. */
  items?: BreadcrumbItem[];
  className?: string;
}

/**
 * A slash-separated location trail; the last crumb is the current page. It lives in the Topbar.
 *
 * @example
 * <Breadcrumbs items={[{ label: "Users", onClick: back }, { label: "Marta Kowalska" }]} />
 */
export function Breadcrumbs({ items = [], className }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 type-label">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={index} className={cn("flex items-center gap-1.5", last ? "min-w-0" : "flex-none")}>
              {last ? (
                <span aria-current="page" className="truncate text-fg-1">
                  {item.label}
                </span>
              ) : (
                <>
                  <a
                    href={item.href ?? "#"}
                    onClick={(event) => {
                      if (!item.onClick) return;
                      event.preventDefault();
                      item.onClick();
                    }}
                    className="whitespace-nowrap text-fg-3 no-underline hover:text-fg-1 focus-visible:shadow-focus"
                  >
                    {item.label}
                  </a>
                  <span aria-hidden="true" className="text-border-strong">
                    /
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
