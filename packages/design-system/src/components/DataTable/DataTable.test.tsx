import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
