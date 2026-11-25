import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { toCssLength } from "../../lib/toCssLength.ts";

const alignClasses = { left: "text-left", right: "text-right", center: "text-center" } as const;

const cellVariants = cva("border-b border-solid border-border-subtle px-4 tabular-nums", {
  variants: {
    mono: { true: "type-mono", false: "type-body" },
    muted: { true: "text-fg-2", false: "text-fg-1" },
    wrap: { true: "whitespace-normal", false: "whitespace-nowrap" },
  },
});

const rowHeights = { compact: "h-row-compact", default: "h-row", relaxed: "h-row-relaxed" } as const;

export interface DataTableColumn<T> {
  /** Identifies the column; without `render`, the cell shows `row[key]` as text ("—" when empty). */
  key: string;
  header: React.ReactNode;
  /** The cell's content for a row. */
  render?: (row: T, index: number) => React.ReactNode;
  /**
   * Numbers (sizes, counts) are right-aligned, header included.
   * @defaultValue "left"
   */
  align?: "left" | "right" | "center";
  /** A fixed width in px; longer text is cut with "…". */
  width?: number;
  /** Geist Mono: IDs, codes, timestamps. */
  mono?: boolean;
  /** Secondary text colour. */
  muted?: boolean;
  /** Lets the text wrap; by default it stays on one line. */
  wrap?: boolean;
}

export interface DataTableProps<T> {
  /** @defaultValue [] */
  columns?: DataTableColumn<T>[];
  /** @defaultValue [] */
  rows?: T[];
  /**
   * The row's React key: a property name, or a function of the row.
   * @defaultValue "id"
   */
  rowKey?: (keyof T & string) | ((row: T) => string | number);
  /**
   * Row height: `compact` 36px, `default` 44px, `relaxed` 52px.
   * @defaultValue "default"
   */
  density?: "compact" | "default" | "relaxed";
  /** Shown in one full-width cell when there are no rows: say why, and what to do (often an EmptyState). */
  empty?: React.ReactNode;
  /** Names the table for screen readers (visually hidden): "Your sessions". */
  caption?: React.ReactNode;
  /** Classes for the scrolling wrapper. */
  className?: string;
}

/** A row's property by name, whatever the row's type. */
function field(row: unknown, key: string): unknown {
  return typeof row === "object" && row !== null ? (Reflect.get(row, key) as unknown) : undefined;
}

function keyOf<T>(row: T, index: number, rowKey: DataTableProps<T>["rowKey"]): React.Key {
  if (typeof rowKey === "function") return rowKey(row);
  const value = field(row, rowKey ?? "id");
  return typeof value === "string" || typeof value === "number" ? value : index;
}

function textOf(row: unknown, key: string): string {
  const value = field(row, key);
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—";
}

/**
 * A data table for records: a sunken header row, 44px rows with hairline dividers, numbers
 * right-aligned in tabular figures. Cells are text unless a column's `render` returns elements (a
 * Badge, a row Menu). No sorting or selection yet.
 *
 * @example
 * <Card title="Sessions" padding="none">
 *   <DataTable caption="Your sessions" rowKey="id" rows={sessions} empty="No other sessions."
 *     columns={[{ key: "device", header: "Device" }, { key: "lastSeen", header: "Last active", muted: true },
 *       { key: "actions", header: "", align: "right", render: (s) => <Button size="sm" variant="secondary">Sign out</Button> }]} />
 * </Card>
 */
export function DataTable<T>({
  columns = [],
  rows = [],
  rowKey,
  density = "default",
  empty = "No results",
  caption,
  className,
}: DataTableProps<T>) {
  return (
    <div className={cn("min-w-0 overflow-x-auto", className)}>
      <table className="w-full border-separate border-spacing-0">
        {caption != null && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{ "--nu-col-w": column.width !== undefined ? toCssLength(column.width) : undefined }}
                className={cn(
                  "h-9 border-b border-solid border-border bg-surface-sunken px-4 whitespace-nowrap",
                  alignClasses[column.align ?? "left"],
                  column.width !== undefined && "w-(--nu-col-w)",
                )}
              >
                {/* type-caption sets the 12px size; the weight goes on the text, as the font shorthand would override it. */}
                <span className="type-caption font-medium text-fg-2">{column.header}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={Math.max(columns.length, 1)} className="px-4 py-12 text-center type-body text-fg-3">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={keyOf(row, index, rowKey)} className={rowHeights[density]}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      cellVariants({ mono: column.mono ?? false, muted: column.muted ?? false, wrap: column.wrap ?? false }),
                      alignClasses[column.align ?? "left"],
                      column.width !== undefined && "max-w-(--nu-col-w) truncate",
                    )}
                    style={{ "--nu-col-w": column.width !== undefined ? toCssLength(column.width) : undefined }}
                  >
                    {column.render ? column.render(row, index) : textOf(row, column.key)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
