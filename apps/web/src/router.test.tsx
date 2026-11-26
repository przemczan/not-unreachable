import { problemTypes } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { browserNavigation } from "./lib/index.ts";
import { adminSession, baseHandlers, json, problem, renderApp, stubApi, userSession } from "./testing/index.ts";

function locationOf(router: ReturnType<typeof renderApp>["router"]): string {
  return router.state.location.pathname + router.state.location.search;
}

const settingsHandlers = {
  "GET /api/v1/settings/profile": () => json(200, adminSession.account),
};

describe("router", () => {
  it.each(["/", "/sign-in", "/admin/audit-log", "/files"])("sends %s to /setup while no admin exists", async (path) => {
    stubApi(baseHandlers({ adminExists: false }));
    const { router } = renderApp(path);

    expect(await screen.findByRole("heading", { level: 1, name: "Create the admin account" })).toBeDefined();
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("sends a signed-out visitor from / to /sign-in", async () => {
    stubApi(baseHandlers());
    const { router } = renderApp("/");

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
    expect(locationOf(router)).toBe("/sign-in");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it.each(["/admin/audit-log", "/files", "/settings/sessions"])("sends a signed-out visitor from %s to /sign-in?next=", async (path) => {
    stubApi(baseHandlers());
    const { router } = renderApp(path);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(locationOf(router)).toBe(`/sign-in?next=${encodeURIComponent(path)}`);
  });

  it.each(["/", "/admin", "/files", "/sign-in"])("lands the admin on /admin/dashboard from %s", async (path) => {
    stubApi(baseHandlers({ session: adminSession }));
    const { router } = renderApp(path);

    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeDefined();
    expect(locationOf(router)).toBe("/admin/dashboard");
  });

  it.each(["/", "/admin", "/admin/settings/security", "/sign-in"])("lands a user on /files from %s", async (path) => {
    stubApi(baseHandlers({ session: userSession }));
    const { router } = renderApp(path);

    expect(await screen.findByRole("heading", { level: 1, name: "Files" })).toBeDefined();
    expect(locationOf(router)).toBe("/files");
    expect(await screen.findByText("No files yet")).toBeDefined();
  });

  it("shows the admin AppShell with only the pages that exist, and the account menu", async () => {
    stubApi(baseHandlers({ session: adminSession }));
    renderApp("/admin/audit-log");

    const nav = await screen.findByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Dashboard", "/admin/dashboard"],
      ["Files", "/admin/files"],
      ["Share links", "/admin/share-links"],
      ["Users", "/admin/users"],
      ["Audit log", "/admin/audit-log"],
      ["Resources", "/admin/resources"],
      ["Settings", "/admin/settings"],
    ]);
    expect(within(nav).getByRole("link", { name: "Audit log" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Account: Ada Admin" })).toBeDefined();
  });

  it("follows a Sidebar link with the router", async () => {
    stubApi({ ...baseHandlers({ session: adminSession }), "GET /api/v1/admin/settings/security": () => json(200, {}) });
    const { router } = renderApp("/admin/audit-log");

    const nav = await screen.findByRole("navigation", { name: "Main" });
    within(nav).getByRole("link", { name: "Settings" }).click();

    await waitFor(() => expect(locationOf(router)).toBe("/admin/settings/security"));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeDefined();
  });

  it("shows the user's AppShell: Files in the Topbar, no Sidebar", async () => {
    stubApi(baseHandlers({ session: userSession }));
    renderApp("/files");

    await screen.findByRole("heading", { level: 1, name: "Files" });
    const nav = within(screen.getByRole("banner")).getByRole("navigation", { name: "Main" });
    expect(screen.getAllByRole("navigation")).toEqual([nav]);
    expect(within(nav).getByRole("link", { name: "Files" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows account settings in the admin's shell, with the Password tab", async () => {
    stubApi({ ...baseHandlers({ session: adminSession }), ...settingsHandlers });
    const { router } = renderApp("/settings");

    expect(await screen.findByRole("heading", { level: 1, name: "Account settings" })).toBeDefined();
    expect(locationOf(router)).toBe("/settings/profile");
    const tabs = screen.getByRole("navigation", { name: "Account settings sections" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Profile", "Password", "Two-step sign-in", "Linked sign-ins", "Sessions"]);
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Audit log" })).toBeDefined();
  });

  it("sends a user from /settings/password to /settings/profile", async () => {
    stubApi({ ...baseHandlers({ session: userSession }), "GET /api/v1/settings/profile": () => json(200, userSession.account) });
    const { router } = renderApp("/settings/password");

    await screen.findByRole("heading", { level: 1, name: "Account settings" });
    await waitFor(() => expect(locationOf(router)).toBe("/settings/profile"));
    const tabs = screen.getByRole("navigation", { name: "Account settings sections" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Profile", "Linked sign-ins", "Sessions"]);
  });

  it("says the page could not be loaded when the session can't be read, instead of sending a signed-in person to sign in", async () => {
    const reload = vi.spyOn(browserNavigation, "reload").mockImplementation(() => undefined);
    stubApi({ ...baseHandlers(), "GET /api/v1/session": () => problem(502, problemTypes.internalError) });
    const { router } = renderApp("/");

    // A 5xx is retried once, a second later, before the page says so.
    expect(await screen.findByRole("heading", { level: 1, name: "Something went wrong" }, { timeout: 3000 })).toBeDefined();
    expect(locationOf(router)).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("renders the not-found page", async () => {
    stubApi(baseHandlers());
    renderApp("/no-such-page");

    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeDefined();
  });
});
