import type { SharedWithMeLink, SharedWithMePage } from "@not-unreachable/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { baseHandlers, json, renderApp, requestsTo, stubApi, userSession, type MockHandler } from "../testing/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const report: SharedWithMeLink = {
  id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a01",
  name: "report.pdf",
  kind: "file",
  expiresAt: iso(3 * DAY_MS),
  hasPassword: true,
  link: "http://localhost/s/0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
};
const photos: SharedWithMeLink = {
  id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a02",
  name: "Photos",
  kind: "folder",
  expiresAt: null,
  hasPassword: false,
  link: "http://localhost/s/GFEDCBAzyxwvutsrqponmlkjihgfedcba9876543210",
};

const route = "GET /api/v1/share-links/shared-with-me";

function handlers(pages: (cursor: string | null) => SharedWithMePage): Record<string, MockHandler> {
  return {
    ...baseHandlers({ session: userSession }),
    [route]: ({ url }) => json(200, pages(url.searchParams.get("cursor"))),
  };
}

const rowOf = (name: string): HTMLElement => {
  const row = screen.getByRole("link", { name }).closest("tr");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
};

describe("Shared with me", () => {
  it("is in the user's sidebar", async () => {
    stubApi(handlers(() => ({ shareLinks: [], nextCursor: null })));
    renderApp("/files");
    const item = await screen.findByRole("link", { name: "Shared with me" });
    expect(item.getAttribute("href")).toBe("/shared");
  });

  it("lists each link's name, kind, expiry and password, and links to its share page", async () => {
    stubApi(handlers(() => ({ shareLinks: [report, photos], nextCursor: null })));
    renderApp("/shared");
    await screen.findByRole("table", { name: "Shared with me" });

    expect(screen.getByRole("link", { name: "report.pdf" }).getAttribute("href")).toBe(report.link);
    expect(screen.getByRole("link", { name: "Photos" }).getAttribute("href")).toBe(photos.link);

    const file = within(rowOf("report.pdf"));
    expect(file.getByText("File")).toBeDefined();
    expect(file.getByText(/^Expires /)).toBeDefined();
    expect(file.getByText("Password")).toBeDefined();

    const folder = within(rowOf("Photos"));
    expect(folder.getByText("Folder")).toBeDefined();
    expect(folder.getByText("No expiry")).toBeDefined();
    expect(folder.queryByText("Password")).toBeNull();
    expect(folder.getByText("None")).toBeDefined();
  });

  it("shows an empty state when nothing is shared", async () => {
    stubApi(handlers(() => ({ shareLinks: [], nextCursor: null })));
    renderApp("/shared");
    expect(await screen.findByText("Nothing is shared with you yet.")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Shared with me pages" })).toBeNull();
  });

  it("pages with the cursor the server gave", async () => {
    const fetchMock = stubApi(
      handlers((cursor) =>
        cursor === null ? { shareLinks: [report], nextCursor: "next-page" } : { shareLinks: [photos], nextCursor: null },
      ),
    );
    renderApp("/shared");
    await screen.findByRole("link", { name: "report.pdf" });

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByRole("link", { name: "Photos" });
    expect(requestsTo(fetchMock, route).map((request) => request.url.searchParams.get("cursor"))).toEqual([null, "next-page"]);

    fireEvent.click(screen.getByRole("button", { name: /previous/i }));
    expect(await screen.findByRole("link", { name: "report.pdf" })).toBeDefined();
  });
});
