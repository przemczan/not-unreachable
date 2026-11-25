import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { SidebarSection } from "../../components/Sidebar/index.ts";
import { AppShell } from "./AppShell.tsx";
import { THEME_STORAGE_KEY } from "./useTheme.ts";

const sections: SidebarSection[] = [
  {
    items: [
      { id: "files", label: "Files", icon: "files", href: "/files" },
      { id: "users", label: "Users", icon: "users", href: "/users" },
    ],
  },
];

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset["theme"];
});

describe("AppShell", () => {
  it("admin: a Sidebar beside the Topbar, and the page in main", () => {
    render(
      <AppShell variant="admin" sections={sections} activeId="users" breadcrumbs={<span>Crumbs</span>}>
        <h1>Users</h1>
      </AppShell>,
    );

    const nav = screen.getByRole("navigation", { name: "Main" });
    const banner = screen.getByRole("banner");
    expect(banner.contains(nav)).toBe(false);
    expect(within(nav).getByRole("link", { name: "Users" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByText("NotUnreachable")).toBeDefined();
    expect(within(banner).getByText("Crumbs")).toBeDefined();
    expect(banner.className).toContain("h-topbar");
    expect(banner.className).toContain("sticky");
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Users" })).toBeDefined();
  });

  it("admin: the sidebar toggle collapses the Sidebar to the mark", async () => {
    const user = userEvent.setup();
    render(<AppShell variant="admin" sections={sections} />);

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav.className).toContain("w-sidebar-collapsed");
    expect(within(nav).getByRole("img", { name: "NotUnreachable" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeDefined();
  });

  it("admin: takes the collapsed state from its prop", () => {
    render(<AppShell variant="admin" sections={sections} collapsed />);

    expect(screen.getByRole("navigation", { name: "Main" }).className).toContain("w-sidebar-collapsed");
  });

  it("user: no Sidebar; the Logo and the navigation are in the Topbar", () => {
    render(
      <AppShell variant="user" sections={[{ items: [{ id: "files", label: "Files", icon: "files", href: "/files" }] }]} activeId="files">
        <h1>Files</h1>
      </AppShell>,
    );

    const banner = screen.getByRole("banner");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(banner.contains(nav)).toBe(true);
    expect(nav.className).not.toContain("w-sidebar");
    expect(within(nav).getByRole("link", { name: "Files" }).getAttribute("aria-current")).toBe("page");
    expect(within(banner).getByText("NotUnreachable")).toBeDefined();
    expect(screen.queryByRole("button", { name: /sidebar/ })).toBeNull();
  });

  it("the theme switch toggles data-theme on <html> and remembers it", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<AppShell variant="user" />);

    expect(document.documentElement.dataset["theme"]).toBe("light");
    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));

    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("opens the account Menu from the Avatar button", async () => {
    const user = userEvent.setup();
    render(<AppShell variant="admin" account={{ name: "Ada Lovelace", items: [{ label: "Sign out" }] }} />);

    await user.click(screen.getByRole("button", { name: "Account: Ada Lovelace" }));

    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeDefined();
  });
});
