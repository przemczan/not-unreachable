import {
  createShareLinkRequestSchema,
  type EntriesPage,
  type Resource,
  type User,
  type ShareLink,
  type ShareLinkDetail,
  type ShareLinksPage,
} from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { adminSession, baseHandlers, json, renderApp, requestsTo, stubApi, type MockHandler } from "../testing/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

const media: Resource = {
  id: "5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d01",
  kind: "local",
  name: "Media",
  localPath: "/srv/media",
  state: "available",
  unavailableReason: null,
  isHomeRoot: false,
  createdAt: "2026-11-20T10:00:00.000Z",
};

const entries: EntriesPage = {
  path: "",
  entries: [
    { name: "Docs", kind: "folder", size: 0, modifiedAt: iso(-DAY_MS) },
    { name: "report.pdf", kind: "file", size: 2_500_000, modifiedAt: iso(-DAY_MS) },
    { name: "elsewhere", kind: "link", size: 0, modifiedAt: iso(-DAY_MS) },
  ],
  nextCursor: null,
};

function shareLink(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a01",
    resourceId: media.id,
    resourceName: media.name,
    path: "Docs/report.pdf",
    name: "report.pdf",
    kind: "file",
    state: "active",
    hasPassword: false,
    access: "anyone",
    allowedUsers: [],
    expiresAt: iso(7 * DAY_MS),
    noExpiry: false,
    lockedUntil: null,
    locked: false,
    downloadCount: 0,
    lastUsedAt: null,
    createdAt: iso(-DAY_MS),
    revokedAt: null,
    ...overrides,
  };
}

function user(id: string, username: string, displayName: string, status: User["status"] = "active"): User {
  return {
    id,
    username,
    email: null,
    displayName,
    status,
    quotaBytes: null,
    linkedSignIns: [],
    createdAt: "2026-11-20T10:00:00.000Z",
    disabledAt: status === "disabled" ? "2026-11-21T10:00:00.000Z" : null,
  };
}

const una = user("5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01", "una", "Una User");
const bob = user("5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02", "bob", "Bob Builder");
const dee = user("5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e03", "dee", "Dee Disabled", "disabled");
const eve = user("5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e04", "eve", "Eve Elsewhere", "disabled");
const allowedOf = ({ id, username, displayName }: User) => ({ id, username, displayName });

const linkUrl = "http://localhost/s/0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const detailOf = (link: ShareLink): ShareLinkDetail => ({ shareLink: link, link: linkUrl });

const links: ShareLink[] = [
  shareLink({
    id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a01",
    hasPassword: true,
    expiresAt: iso(3 * DAY_MS + 3600 * 1000),
    downloadCount: 1234,
    lastUsedAt: iso(-3600 * 1000),
  }),
  shareLink({
    id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a02",
    name: "Photos",
    path: "Photos",
    kind: "folder",
    expiresAt: null,
    noExpiry: true,
    hasPassword: true,
    locked: true,
    lockedUntil: iso(3600 * 1000),
  }),
  shareLink({ id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a03", name: "old.zip", path: "old.zip", state: "expired", expiresAt: iso(-DAY_MS) }),
  shareLink({ id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a04", name: "gone.txt", path: "gone.txt", state: "revoked", revokedAt: iso(-DAY_MS) }),
  shareLink({ id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a05", name: "team.txt", path: "team.txt", access: "signed-in" }),
  shareLink({
    id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a06",
    name: "plans.txt",
    path: "plans.txt",
    access: "selected-users",
    allowedUsers: [allowedOf(dee), allowedOf(una)],
  }),
  shareLink({ id: "8a1c0f3e-5b6d-4e7f-8a9b-0c1d2e3f4a07", name: "solo.txt", path: "solo.txt", access: "selected-users", allowedUsers: [] }),
];

function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    ...baseHandlers({ session: adminSession }),
    "GET /api/v1/admin/resources": () => json(200, { resources: [media], homeRoot: null }),
    [`GET /api/v1/admin/resources/${media.id}/entries`]: () => json(200, entries),
    "GET /api/v1/admin/share-links": () => json(200, { shareLinks: links, nextCursor: null } satisfies ShareLinksPage),
    "GET /api/v1/admin/users": () => json(200, { users: [una, bob, dee, eve], defaultQuotaBytes: 0 }),
    "POST /api/v1/admin/share-links": ({ body }) => {
      const request = createShareLinkRequestSchema.parse(body);
      return json(201, detailOf(shareLink({ hasPassword: request.password !== undefined, access: request.access })));
    },
    ...extra,
  };
}

/** A Checkbox's label text alone, without its description. */
const labelOf = (box: HTMLElement) => document.getElementById(box.getAttribute("aria-labelledby") ?? "")?.textContent;

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table")).getByText(name, { exact: true }).closest("tr");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
}

async function openShareDialog(name: string): Promise<HTMLElement> {
  await screen.findByRole("table", { name: "Media" });
  fireEvent.click(screen.getByRole("button", { name: `Share ${name}` }));
  return screen.findByRole("dialog", { name: `Share ${name}` });
}

describe("share link dialog", () => {
  it("offers a Share link button on files and folders only, not in the row menu", async () => {
    stubApi(handlers());
    renderApp(`/admin/files/${media.id}`);
    await screen.findByRole("table", { name: "Media" });

    expect(screen.getByRole("button", { name: "Share Docs" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Share report.pdf" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Share elsewhere" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Docs" }));
    expect(screen.queryByRole("menuitem", { name: "Share link" })).toBeNull();
  });

  it("creates a password-protected link expiring in 7 days, then shows it to copy", async () => {
    const fetchMock = stubApi(handlers());
    renderApp(`/admin/files/${media.id}`);
    const dialog = await openShareDialog("report.pdf");

    expect(within(dialog).getByRole("radio", { name: "7 days" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).queryByLabelText("Password")).toBeNull();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Require a password" }));
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create share link" }));
    expect(await within(dialog).findByText("Use at least 8 characters.")).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/admin/share-links")).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "long enough secret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create share link" }));

    const created = await screen.findByRole("dialog", { name: "Share link created" });
    expect(within(created).getByRole("group", { name: "Link" }).querySelector("code")?.textContent).toBe(linkUrl);
    expect(within(created).getByText(/Anyone with the link can open it\. Send the password separately/)).toBeDefined();

    const [request] = requestsTo(fetchMock, "POST /api/v1/admin/share-links");
    const body = createShareLinkRequestSchema.parse(request?.body);
    expect(body).toEqual({
      resourceId: media.id,
      path: "report.pdf",
      password: "long enough secret",
      access: "anyone",
      expiresAt: expect.any(String),
    });
    expect(Math.abs(new Date(body.expiresAt ?? "").getTime() - (Date.now() + 7 * DAY_MS))).toBeLessThan(60_000);

    fireEvent.click(within(created).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("warns about No expiry and sends noExpiry: true for it", async () => {
    const fetchMock = stubApi(handlers());
    renderApp(`/admin/files/${media.id}`);
    const dialog = await openShareDialog("Docs");

    expect(within(dialog).queryByText("This link never expires")).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: "No expiry" }));
    expect(within(dialog).getByText("This link never expires")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create share link" }));

    await screen.findByRole("dialog", { name: "Share link created" });
    expect(requestsTo(fetchMock, "POST /api/v1/admin/share-links")[0]?.body).toEqual({
      resourceId: media.id,
      path: "Docs",
      access: "anyone",
      noExpiry: true,
    });
  });

  it("shares with signed-in users only", async () => {
    const fetchMock = stubApi(handlers());
    renderApp(`/admin/files/${media.id}`);
    const dialog = await openShareDialog("report.pdf");

    expect(within(dialog).getByRole("radio", { name: "Anyone with the link" })).toHaveProperty("checked", true);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Signed-in users" }));
    expect(within(dialog).queryByRole("group", { name: "Users" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create share link" }));

    const created = await screen.findByRole("dialog", { name: "Share link created" });
    expect(within(created).getByText(/Only signed-in users can open it\./)).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/admin/share-links")[0]?.body).toMatchObject({ access: "signed-in" });
    expect(requestsTo(fetchMock, "POST /api/v1/admin/share-links")[0]?.body).not.toHaveProperty("allowedUserIds");
  });

  it("shares with the users picked, active ones only, and asks for at least one", async () => {
    const fetchMock = stubApi(handlers());
    renderApp(`/admin/files/${media.id}`);
    const dialog = await openShareDialog("report.pdf");

    fireEvent.click(within(dialog).getByRole("radio", { name: "Selected users" }));
    const users = await within(dialog).findByRole("group", { name: "Users" });
    // Active users only, by username: Dee and Eve are disabled.
    expect(within(users).getAllByRole("checkbox").map(labelOf)).toEqual(["Bob Builder", "Una User"]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Create share link" }));
    expect(await within(dialog).findByText("Pick at least one user.")).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/admin/share-links")).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Filter users" }), { target: { value: "UNA" } });
    expect(within(users).queryByRole("checkbox", { name: "Bob Builder" })).toBeNull();
    fireEvent.click(within(users).getByRole("checkbox", { name: "Una User" }));
    expect(within(dialog).queryByText("Pick at least one user.")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create share link" }));

    const created = await screen.findByRole("dialog", { name: "Share link created" });
    expect(within(created).getByText(/Only the users you picked, and you, can open it\./)).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/admin/share-links")[0]?.body).toMatchObject({
      access: "selected-users",
      allowedUserIds: [una.id],
    });
  });

  it("asks for a custom time in the future", async () => {
    const fetchMock = stubApi(handlers());
    renderApp(`/admin/files/${media.id}`);
    const dialog = await openShareDialog("report.pdf");

    fireEvent.click(within(dialog).getByRole("radio", { name: "Custom" }));
    fireEvent.change(within(dialog).getByLabelText("Expiry date and time"), { target: { value: "2020-01-01T10:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create share link" }));
    expect(await within(dialog).findByText("Choose a time in the future.")).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/admin/share-links")).toHaveLength(0);
  });
});

describe("Share links screen", () => {
  it("is in the admin's Sidebar and lists every link with its badges, downloads and last use", async () => {
    stubApi(handlers());
    renderApp("/admin/share-links");

    expect(await screen.findByRole("heading", { level: 1, name: "Share links" })).toBeDefined();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Share links" }).getAttribute("aria-current")).toBe("page");
    await screen.findByRole("table", { name: "Share links" });

    const report = rowOf("report.pdf");
    expect(within(report).getByText("Media / Docs/report.pdf")).toBeDefined();
    expect(
      within(report).getByText(
        `Expires ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(links[0]?.expiresAt ?? ""))}`,
      ),
    ).toBeDefined();
    expect(within(report).getByText("Password")).toBeDefined();
    expect(within(report).getByText(new Intl.NumberFormat().format(1234))).toBeDefined();
    expect(within(report).getByText("1 hour ago")).toBeDefined();

    const photos = rowOf("Photos");
    expect(within(photos).getByText("No expiry")).toBeDefined();
    expect(within(photos).getByText("Locked")).toBeDefined();
    expect(within(rowOf("old.zip")).getByText("Expired")).toBeDefined();
    expect(within(rowOf("gone.txt")).getByText("Revoked")).toBeDefined();
    expect(within(rowOf("gone.txt")).getByText("None")).toBeDefined();

    expect(within(report).getByText("Anyone with the link")).toBeDefined();
    expect(within(rowOf("team.txt")).getByText("Signed-in users")).toBeDefined();
    expect(within(rowOf("plans.txt")).getByText("2 users").closest("[title]")?.getAttribute("title")).toBe("dee, una");
    expect(within(rowOf("solo.txt")).getByText("Only you")).toBeDefined();
  });

  it("filters by state and pages with the cursor", async () => {
    const fetchMock = stubApi(
      handlers({
        "GET /api/v1/admin/share-links": ({ url }) =>
          url.searchParams.get("cursor") === "next-page"
            ? json(200, { shareLinks: [links[2]], nextCursor: null })
            : json(200, { shareLinks: [links[0]], nextCursor: "next-page" }),
      }),
    );
    renderApp("/admin/share-links");
    await screen.findByText("report.pdf");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("old.zip")).toBeDefined();
    expect(requestsTo(fetchMock, "GET /api/v1/admin/share-links").at(-1)?.url.searchParams.get("cursor")).toBe("next-page");

    fireEvent.click(screen.getByRole("button", { name: "Expired" }));
    await waitFor(() =>
      expect(requestsTo(fetchMock, "GET /api/v1/admin/share-links").at(-1)?.url.searchParams.get("state")).toBe("expired"),
    );
    // Another filter starts again at the first page.
    expect(requestsTo(fetchMock, "GET /api/v1/admin/share-links").at(-1)?.url.searchParams.get("cursor")).toBeNull();
    expect(screen.getByRole("button", { name: "Expired" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("revokes a link after confirming", async () => {
    const revokePath = `/api/v1/admin/share-links/${links[0]?.id}/revoke`;
    const fetchMock = stubApi(handlers({ [`POST ${revokePath}`]: () => json(200, { ...links[0], state: "revoked", revokedAt: iso(0) }) }));
    renderApp("/admin/share-links");
    await screen.findByText("report.pdf");

    fireEvent.click(within(rowOf("report.pdf")).getByRole("button", { name: "Actions for report.pdf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke the link to report.pdf?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke link" }));

    expect(await screen.findByText("Link revoked")).toBeDefined();
    expect(requestsTo(fetchMock, `POST ${revokePath}`)).toHaveLength(1);
  });

  it("disables the actions of a revoked link", async () => {
    stubApi(handlers());
    renderApp("/admin/share-links");
    await screen.findByText("gone.txt");

    fireEvent.click(within(rowOf("gone.txt")).getByRole("button", { name: "Actions for gone.txt" }));
    for (const name of ["Copy link", "Edit", "Revoke"]) {
      expect(screen.getByRole<HTMLButtonElement>("menuitem", { name }).disabled).toBe(true);
    }
  });

  it("copies a link, read from the server", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    // jsdom has no clipboard.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    onTestFinished(() => {
      Reflect.deleteProperty(navigator, "clipboard");
    });
    stubApi(handlers({ [`GET /api/v1/admin/share-links/${links[0]?.id}`]: () => json(200, detailOf(shareLink())) }));
    renderApp("/admin/share-links");
    await screen.findByText("report.pdf");

    fireEvent.click(within(rowOf("report.pdf")).getByRole("button", { name: "Actions for report.pdf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));

    expect(await screen.findByText("Link copied")).toBeDefined();
    expect(writeText).toHaveBeenCalledWith(linkUrl);
  });

  it("edits a link: Save waits for a change, and turning the password off removes it", async () => {
    const changePath = `/api/v1/admin/share-links/${links[0]?.id}`;
    const fetchMock = stubApi(handlers({ [`PATCH ${changePath}`]: () => json(200, detailOf(shareLink())) }));
    renderApp("/admin/share-links");
    await screen.findByText("report.pdf");

    fireEvent.click(within(rowOf("report.pdf")).getByRole("button", { name: "Actions for report.pdf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the link to report.pdf" });

    const save = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save changes" });
    expect(save.disabled).toBe(true);
    expect(within(dialog).getByRole("switch", { name: "Require a password" })).toHaveProperty("checked", true);
    expect(within(dialog).getByText(/Leave it empty to keep the current password/)).toBeDefined();
    expect(within(dialog).getByRole("radio", { name: "Custom" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(dialog).getByRole("switch", { name: "Require a password" }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect(await screen.findByText("Share link saved")).toBeDefined();
    expect(requestsTo(fetchMock, `PATCH ${changePath}`)[0]?.body).toEqual({ password: null });
  });

  it("edits who can open a link: the users listed are checked, a disabled one still shown, and the new list sent whole", async () => {
    const plans = links[5];
    const changePath = `/api/v1/admin/share-links/${plans?.id}`;
    const fetchMock = stubApi(handlers({ [`PATCH ${changePath}`]: () => json(200, detailOf(shareLink())) }));
    renderApp("/admin/share-links");
    await screen.findByText("plans.txt");

    fireEvent.click(within(rowOf("plans.txt")).getByRole("button", { name: "Actions for plans.txt" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the link to plans.txt" });

    expect(within(dialog).getByRole("radio", { name: "Selected users" })).toHaveProperty("checked", true);
    const users = await within(dialog).findByRole("group", { name: "Users" });
    // Dee is disabled but listed, so she stays to be taken off; Eve is disabled and not listed.
    expect(within(users).getByRole("checkbox", { name: "Dee Disabled" })).toHaveProperty("checked", true);
    expect(within(users).getByRole("checkbox", { name: "Una User" })).toHaveProperty("checked", true);
    expect(within(users).getByRole("checkbox", { name: "Bob Builder" })).toHaveProperty("checked", false);
    expect(within(users).queryByRole("checkbox", { name: "Eve Elsewhere" })).toBeNull();

    const save = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save changes" });
    expect(save.disabled).toBe(true);
    fireEvent.click(within(users).getByRole("checkbox", { name: "Dee Disabled" }));
    fireEvent.click(within(users).getByRole("checkbox", { name: "Bob Builder" }));
    fireEvent.click(save);

    expect(await screen.findByText("Share link saved")).toBeDefined();
    expect(requestsTo(fetchMock, `PATCH ${changePath}`)[0]?.body).toEqual({ access: "selected-users", allowedUserIds: [una.id, bob.id] });
  });

  it("sends only the access when a link opens to anyone again", async () => {
    const changePath = `/api/v1/admin/share-links/${links[5]?.id}`;
    const fetchMock = stubApi(handlers({ [`PATCH ${changePath}`]: () => json(200, detailOf(shareLink())) }));
    renderApp("/admin/share-links");
    await screen.findByText("plans.txt");

    fireEvent.click(within(rowOf("plans.txt")).getByRole("button", { name: "Actions for plans.txt" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the link to plans.txt" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Anyone with the link" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Share link saved")).toBeDefined();
    expect(requestsTo(fetchMock, `PATCH ${changePath}`)[0]?.body).toEqual({ access: "anyone" });
  });
});
