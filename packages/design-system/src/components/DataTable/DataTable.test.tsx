import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./DataTable.tsx";

interface Session {
  id: string;
  device: string;
  ip: string | null;
  requests: number;
}

const rows: Session[] = [
  { id: "ses_1", device: "Firefox on Linux", ip: "10.0.0.4", requests: 1284 },
  { id: "ses_2", device: "Safari on iPhone", ip: null, requests: 12 },
];

const columns: DataTableColumn<Session>[] = [
  { key: "device", header: "Device" },
  { key: "ip", header: "IP address", mono: true, muted: true },
  { key: "requests", header: "Requests", align: "right", render: (row) => row.requests.toLocaleString("en-US") },
  { key: "actions", header: "Actions", align: "right", width: 120, render: (row) => <button type="button">Sign out {row.id}</button> },
];

describe("DataTable", () => {
  it("is a table named by its caption, with column headers", () => {
    render(<DataTable caption="Your sessions" columns={columns} rows={rows} />);
    const table = screen.getByRole("table", { name: "Your sessions" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Device", "IP address", "Requests", "Actions"]);
    expect(screen.getByRole("columnheader", { name: "Device" }).getAttribute("scope")).toBe("col");
  });

  it("renders one row per record, cells as text or from render, an em dash for no value", () => {
    render(<DataTable columns={columns} rows={rows} />);
    const [, first, second] = screen.getAllByRole("row");
    expect(
      within(first!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Firefox on Linux", "10.0.0.4", "1,284", "Sign out ses_1"]);
    expect(within(second!).getByText("—")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out ses_2" })).toBeTruthy();
  });

  it("right-aligns numbers in header and cells, in tabular figures", () => {
    render(<DataTable columns={columns} rows={rows} />);
    expect(screen.getByRole("columnheader", { name: "Requests" }).classList).toContain("text-right");
    const cell = screen.getByRole("cell", { name: "1,284" });
    expect(cell.classList).toContain("text-right");
    expect(cell.classList).toContain("tabular-nums");
  });

  it("styles mono and muted columns, and sets widths through a custom property", () => {
    render(<DataTable columns={columns} rows={rows} />);
    const ip = screen.getByRole("cell", { name: "10.0.0.4" });
    expect(ip.classList).toContain("type-mono");
    expect(ip.classList).toContain("text-fg-2");
    const actions = screen.getByRole("columnheader", { name: "Actions" });
    expect(actions.getAttribute("style")).toBe("--nu-col-w: 120px;");
    expect(actions.classList).toContain("w-(--nu-col-w)");
  });

  it("uses the row height of its density", () => {
    render(<DataTable columns={columns} rows={rows} density="compact" />);
    expect(screen.getAllByRole("row")[1]!.classList).toContain("h-row-compact");
  });

  it("keys rows with a function too", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.device} />);
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("shows the empty content across all columns when there are no rows", () => {
    render(<DataTable columns={columns} rows={[]} empty="No other sessions." />);
    const cell = screen.getByRole("cell", { name: "No other sessions." });
    expect(cell.getAttribute("colspan")).toBe("4");
  });

  it("says No results by default", () => {
    render(<DataTable columns={columns} />);
    expect(screen.getByRole("cell", { name: "No results" })).toBeTruthy();
  });

  describe("sorting", () => {
    const sortable: DataTableColumn<Session>[] = [
      { key: "device", header: "Device", sortable: true },
      { key: "ip", header: "IP address" },
      { key: "requests", header: "Requests", align: "right", sortable: true },
    ];

    it("makes sortable headers buttons, and leaves the others text", () => {
      render(<DataTable columns={sortable} rows={rows} />);
      const device = screen.getByRole("columnheader", { name: "Device" });
      expect(within(device).getByRole("button", { name: "Device" }).getAttribute("type")).toBe("button");
      expect(within(screen.getByRole("columnheader", { name: "IP address" })).queryByRole("button")).toBeNull();
    });

    it("sets aria-sort on the sorted column only, and shows its direction with an arrow", () => {
      const { rerender } = render(<DataTable columns={sortable} rows={rows} sort={{ key: "requests", order: "desc" }} />);
      const requests = screen.getByRole("columnheader", { name: "Requests" });
      const device = screen.getByRole("columnheader", { name: "Device" });
      expect(requests.getAttribute("aria-sort")).toBe("descending");
      expect(device.hasAttribute("aria-sort")).toBe(false);
      expect(screen.getByRole("columnheader", { name: "IP address" }).hasAttribute("aria-sort")).toBe(false);
      expect(requests.querySelector("svg")?.classList).toContain("rotate-180");
      expect(device.querySelector("svg")).toBeNull();

      rerender(<DataTable columns={sortable} rows={rows} sort={{ key: "device", order: "asc" }} />);
      expect(device.getAttribute("aria-sort")).toBe("ascending");
      expect(device.querySelector("svg")?.classList).not.toContain("rotate-180");
      expect(requests.hasAttribute("aria-sort")).toBe(false);
      expect(requests.querySelector("svg")).toBeNull();
    });

    it("calls onSortChange with the clicked column's key, and leaves the sort to the caller", () => {
      const onSortChange = vi.fn<(key: string) => void>();
      render(<DataTable columns={sortable} rows={rows} sort={{ key: "device", order: "asc" }} onSortChange={onSortChange} />);
      fireEvent.click(screen.getByRole("button", { name: "Requests" }));
      fireEvent.click(screen.getByRole("button", { name: "Device" }));
      expect(onSortChange.mock.calls).toEqual([["requests"], ["device"]]);
      expect(screen.getByRole("columnheader", { name: "Device" }).getAttribute("aria-sort")).toBe("ascending");
    });
  });

  it("highlights rows on hover only when asked", () => {
    const { rerender } = render(<DataTable columns={columns} rows={rows} />);
    expect(screen.getAllByRole("row")[1]!.classList).not.toContain("hover:bg-surface-hover");
    rerender(<DataTable columns={columns} rows={rows} highlightRowOnHover />);
    expect(screen.getAllByRole("row")[1]!.classList).toContain("hover:bg-surface-hover");
  });
});
