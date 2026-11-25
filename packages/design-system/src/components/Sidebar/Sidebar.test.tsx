import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarSection } from "./Sidebar.tsx";

const sections: SidebarSection[] = [
  { items: [{ id: "overview", label: "Overview", icon: "layout-dashboard" }] },
  {
    title: "Manage",
    items: [
      { id: "users", label: "Users", icon: "users", badge: 1284, href: "/users" },
      { id: "settings", label: "Settings", icon: "settings" },
    ],
  },
];

describe("Sidebar", () => {
  it("is the main navigation with header, grouped items and footer", () => {
    render(<Sidebar header={<span>Logo</span>} sections={sections} footer={<span>Jan</span>} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav.classList).toContain("w-sidebar");
    expect(within(nav).getByText("Logo")).toBeTruthy();
    expect(within(nav).getByText("Jan")).toBeTruthy();
    const manage = screen.getByRole("list", { name: "Manage" });
    expect(within(manage).getByRole("link", { name: /Users/ })).toBeTruthy();
    expect(within(manage).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(within(manage).getByText("1284")).toBeTruthy();
  });

  it("renders items with href as links and the rest as buttons", () => {
    render(<Sidebar sections={sections} />);
    expect(screen.getByRole("link", { name: /Users/ }).getAttribute("href")).toBe("/users");
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("type")).toBe("button");
  });

  it("marks the active item as the current page, with the active colours", () => {
    render(<Sidebar sections={sections} activeId="users" />);
    const active = screen.getByRole("link", { name: /Users/ });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.classList).toContain("bg-sidebar-active");
    expect(active.classList).toContain("text-sidebar-active-fg");
    const other = screen.getByRole("button", { name: "Overview" });
    expect(other.getAttribute("aria-current")).toBeNull();
    expect(other.classList).toContain("text-sidebar-fg");
  });

  it("calls onSelect with the item's id", async () => {
    const onSelect = vi.fn<(id: string) => void>();
    render(<Sidebar sections={sections} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("shows icons only when collapsed, keeping each item named by its label", () => {
    render(<Sidebar sections={sections} collapsed />);
    expect(screen.getByRole("navigation").classList).toContain("w-sidebar-collapsed");
    const users = screen.getByRole("link", { name: "Users" });
    expect(users.getAttribute("title")).toBe("Users");
    expect(users.textContent).toBe("");
    expect(screen.queryByText("1284")).toBeNull();
    expect(screen.queryByText("Manage")).toBeNull();
  });
});
