import { problemTypes, type AuditEvent, type Dashboard } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adminSession, baseHandlers, json, problem, renderApp, requestsTo, stubApi, type MockHandler } from "../testing/index.ts";

const dashboard: Dashboard = {
  users: { active: 12, disabled: 2 },
  pendingInvitations: 3,
  resources: { available: 4, unavailable: 1 },
  shareLinks: { active: 7, expired: 5, revoked: 1, locked: 2, downloads: 1234 },
  recentUploaders: [
    {
      userId: "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02",
      username: "bob",
      displayName: "Bob Builder",
      uploads: 3,
      lastUploadAt: "2026-11-24T10:15:00.000Z",
    },
    {
      userId: "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01",
      username: "una",
      displayName: "Una User",
      uploads: 1,
      lastUploadAt: "2026-11-23T09:00:00.000Z",
    },
  ],
};

function event(id: number, change: Partial<AuditEvent>): AuditEvent {
  return {
    id: `01900000-0000-7000-8000-00000000000${id}`,
    at: "2026-11-24T10:15:00.000Z",
    actorKind: "account",
    actorAccountId: "01900000-0000-7000-8000-000000000100",
    actorUsername: "ada",
    action: "sign-in.succeeded",
    targetKind: null,
    targetId: null,
    outcome: "succeeded",
    ip: "203.0.113.7",
    userAgent: null,
    details: {},
    ...change,
  };
}

const events: AuditEvent[] = [
  event(1, { action: "share-link.created", targetKind: "share-link", targetId: "abc" }),
  event(2, { action: "sign-in.failed", outcome: "failed", actorUsername: null, actorKind: "anonymous" }),
];

function stubDashboard(handlers: Record<string, MockHandler> = {}) {
  return stubApi({
    ...baseHandlers({ session: adminSession }),
    "GET /api/v1/admin/dashboard": () => json(200, dashboard),
    "GET /api/v1/admin/audit-events": () => json(200, { events, nextCursor: null }),
    ...handlers,
  });
}

const count = new Intl.NumberFormat();

describe("Admin → Dashboard", () => {
  it("shows each count with its breakdown and a link to its page", async () => {
    stubDashboard();
    renderApp("/admin/dashboard");

    const users = await screen.findByRole("region", { name: "Users" });
    expect(within(users).getByText("12")).toBeDefined();
    expect(within(users).getByText("active · 2 disabled")).toBeDefined();
    expect(within(users).getByRole("link", { name: "View users" }).getAttribute("href")).toBe("/admin/users");

    const invitations = screen.getByRole("region", { name: "Invitations" });
    expect(within(invitations).getByText("3")).toBeDefined();
    expect(within(invitations).getByText("pending")).toBeDefined();
    expect(within(invitations).getByRole("link", { name: "View invitations" }).getAttribute("href")).toBe("/admin/users/invitations");

    const resources = screen.getByRole("region", { name: "Resources" });
    expect(within(resources).getByText("4")).toBeDefined();
    expect(within(resources).getByText("available · 1 unavailable")).toBeDefined();
    expect(within(resources).getByRole("link", { name: "View resources" }).getAttribute("href")).toBe("/admin/resources");

    const shareLinks = screen.getByRole("region", { name: "Share links" });
    expect(within(shareLinks).getByText("7")).toBeDefined();
    expect(within(shareLinks).getByText("active · 5 expired · 1 revoked · 2 locked")).toBeDefined();
    expect(within(shareLinks).getByText(`${count.format(1234)} downloads in total`)).toBeDefined();
    expect(within(shareLinks).getByRole("link", { name: "View share links" }).getAttribute("href")).toBe("/admin/share-links");

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows the five newest audit events, worded as the audit log words them", async () => {
    const fetchMock = stubDashboard();
    renderApp("/admin/dashboard");

    const activity = await screen.findByRole("region", { name: "Recent activity" });
    expect(await within(activity).findByText("Share link created")).toBeDefined();
    expect(within(activity).getByText("by ada · share-link abc · 203.0.113.7")).toBeDefined();
    expect(within(activity).getByText("Sign-in failed")).toBeDefined();
    expect(within(activity).getByText("by Anonymous · 203.0.113.7")).toBeDefined();
    expect(within(activity).getByText("Failed")).toBeDefined();
    expect(within(activity).getByRole("link", { name: "View audit log" }).getAttribute("href")).toBe("/admin/audit-log");
    expect(within(activity).queryByRole("button", { name: "Details" })).toBeNull();

    const requests = requestsTo(fetchMock, "GET /api/v1/admin/audit-events");
    expect(requests.map((request) => request.url.searchParams.get("limit"))).toEqual(["5"]);
  });

  it("shows the recent uploaders between the counts and Recent activity, each linking to their files", async () => {
    const fetchMock = stubDashboard();
    renderApp("/admin/dashboard");

    const uploads = await screen.findByRole("region", { name: "Recent uploads" });
    expect(within(uploads).getByText("Users who uploaded files in the last 7 days.")).toBeDefined();
    const rows = within(uploads).getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/admin/users/5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02/files",
      "/admin/users/5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01/files",
    ]);
    const bob = within(uploads).getByRole("link", { name: /Bob Builder/ });
    expect(within(bob).getByText("bob")).toBeDefined();
    expect(within(bob).getByText("3 uploads")).toBeDefined();
    expect(bob.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-24T10:15:00.000Z");
    const una = within(uploads).getByRole("link", { name: /Una User/ });
    expect(within(una).getByText("1 upload")).toBeDefined();

    // Counts, then Recent uploads, then Recent activity.
    const users = screen.getByRole("region", { name: "Users" });
    const activity = screen.getByRole("region", { name: "Recent activity" });
    expect(users.compareDocumentPosition(uploads) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(uploads.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // From the Dashboard's own answer: no request of its own.
    expect(requestsTo(fetchMock, "GET /api/v1/admin/dashboard")).toHaveLength(1);
  });

  it("says when nobody uploaded lately", async () => {
    stubApi(baseHandlers({ session: adminSession }));
    renderApp("/admin/dashboard");

    const uploads = await screen.findByRole("region", { name: "Recent uploads" });
    expect(within(uploads).getByText("No uploads this week")).toBeDefined();
    expect(within(uploads).queryByRole("link")).toBeNull();
  });

  it("shows a new instance's zero counts and no activity", async () => {
    stubApi(baseHandlers({ session: adminSession }));
    renderApp("/admin/dashboard");

    const users = await screen.findByRole("region", { name: "Users" });
    expect(within(users).getByText("0")).toBeDefined();
    expect(within(users).getByText("active · 0 disabled")).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Share links" })).getByText("0 downloads in total")).toBeDefined();
    const activity = screen.getByRole("region", { name: "Recent activity" });
    expect(await within(activity).findByText("No activity yet")).toBeDefined();
  });

  it("says when the counts could not be loaded, and loads them again on Try again", async () => {
    let fail = true;
    stubDashboard({
      "GET /api/v1/admin/dashboard": () =>
        fail ? problem(403, problemTypes.forbidden, "Forbidden", "The counts are not available.") : json(200, dashboard),
    });
    renderApp("/admin/dashboard");

    expect(await screen.findByText("The counts could not be loaded")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Users" })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const users = await screen.findByRole("region", { name: "Users" });
    expect(within(users).getByText("12")).toBeDefined();
    await waitFor(() => expect(screen.queryByText("The counts could not be loaded")).toBeNull());
  });

  it("says when recent activity could not be loaded, and loads it again on Try again", async () => {
    let fail = true;
    stubDashboard({
      "GET /api/v1/admin/audit-events": () =>
        fail ? problem(403, problemTypes.forbidden, "Forbidden") : json(200, { events, nextCursor: null }),
    });
    renderApp("/admin/dashboard");

    const activity = await screen.findByRole("region", { name: "Recent activity" });
    expect(await within(activity).findByText("Recent activity could not be loaded")).toBeDefined();
    fail = false;
    fireEvent.click(within(activity).getByRole("button", { name: "Try again" }));

    expect(await within(activity).findByText("Share link created")).toBeDefined();
  });
});
