import { problemTypes, type EntriesPage, type Entry, type Resource, type User } from "@not-unreachable/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminSession, baseHandlers, json, problem, renderApp, requestsTo, stubApi, type MockHandler } from "../testing/index.ts";

interface FakeUpload {
  readonly options: { metadata: { folder?: string; name?: string; onConflict?: string; resourceId?: string } };
}

const tus = vi.hoisted(() => ({ instances: [] as FakeUpload[] }));

vi.mock("tus-js-client", () => {
  class Upload {
    readonly start = vi.fn<() => void>();
    readonly abort = vi.fn<(terminate?: boolean) => Promise<void>>(() => Promise.resolve());
    readonly findPreviousUploads = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
    readonly resumeFromPreviousUpload = vi.fn<(previous: unknown) => void>();
    readonly options: FakeUpload["options"];
    constructor(_file: File, options: FakeUpload["options"]) {
      this.options = options;
      tus.instances.push(this);
    }
    static terminate = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
  }
  const urlStorage = {
    findAllUploads: () => Promise.resolve([]),
    findUploadsByFingerprint: () => Promise.resolve([]),
    removeUpload: () => Promise.resolve(),
    addUpload: () => Promise.resolve("key"),
  };
  return { Upload, defaultOptions: { urlStorage } };
});

const { uploadStoreFor } = await import("../files/index.ts");

const homes: Resource = {
  id: "5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d01",
  kind: "local",
  name: "Homes",
  localPath: "/srv/homes",
  state: "available",
  unavailableReason: null,
  isHomeRoot: true,
  createdAt: "2026-11-20T10:00:00.000Z",
};

const bob: User = {
  id: "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02",
  username: "bob",
  email: null,
  displayName: "Bob Builder",
  status: "active",
  quotaBytes: null,
  linkedSignIns: [],
  home: { resourceId: homes.id, path: "users/bob" },
  createdAt: "2026-11-20T10:00:00.000Z",
  disabledAt: null,
};

const modifiedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const docs: Entry = { name: "Docs", kind: "folder", size: 0, modifiedAt };
const plan: Entry = { name: "plan.pdf", kind: "file", size: 1_000, modifiedAt };

function page(path: string, entries: Entry[]): EntriesPage {
  return { path, entries, nextCursor: null };
}

const filesPage = `/admin/users/${bob.id}/files`;
const entriesRoute = `GET /api/v1/admin/resources/${homes.id}/entries`;

/** Bob's home holds Docs, which holds plan.pdf; the server answers resource-relative paths. */
function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    ...baseHandlers({ session: adminSession }),
    [`GET /api/v1/admin/users/${bob.id}`]: () => json(200, bob),
    "GET /api/v1/admin/resources": () => json(200, { resources: [homes], homeRoot: null }),
    [entriesRoute]: ({ url }) => {
      const path = url.searchParams.get("path") ?? "";
      return json(200, path === "users/bob/Docs" ? page(path, [plan]) : page(path, [docs]));
    },
    ...extra,
  };
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table")).getByText(name).closest("tr");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
}

afterEach(() => {
  const store = uploadStoreFor(adminSession.account.id);
  for (const record of store.getSnapshot()) store.cancel(record.id);
  tus.instances.length = 0;
});

describe("Admin → Users → a user's files", () => {
  it("lists the user's home through the resource's routes, under the home's folder", async () => {
    const fetchMock = stubApi(handlers());
    renderApp(filesPage);

    expect(await screen.findByRole("heading", { level: 1, name: "Files of Bob Builder" })).toBeDefined();
    await screen.findByRole("table", { name: "Bob Builder" });
    expect(screen.getByText("The home folder of bob, in Homes.")).toBeDefined();
    expect(requestsTo(fetchMock, entriesRoute).map((request) => request.url.searchParams.get("path"))).toEqual(["users/bob"]);
    expect(screen.getByRole("link", { name: "Back to Users" }).getAttribute("href")).toBe("/admin/users");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Users" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens a folder with its path relative to the home, the user's name at the top of the Breadcrumbs", async () => {
    const fetchMock = stubApi(handlers());
    const { router } = renderApp(filesPage);
    await screen.findByRole("table", { name: "Bob Builder" });

    fireEvent.click(within(rowOf("Docs")).getByRole("link", { name: "Docs" }));
    await screen.findByRole("table", { name: "Bob Builder / Docs" });
    expect(router.state.location.pathname + router.state.location.search).toBe(`${filesPage}?path=Docs`);
    expect(requestsTo(fetchMock, entriesRoute).at(-1)?.url.searchParams.get("path")).toBe("users/bob/Docs");
    // The shell's Breadcrumbs name the Users page; the file browser's start at the user's name.
    const crumbs = screen.getAllByRole("navigation", { name: "Breadcrumb" }).at(-1);
    if (crumbs === undefined) throw new Error("No Breadcrumbs");
    expect(within(crumbs).getByRole("link", { name: "Bob Builder" }).getAttribute("href")).toBe(filesPage);
    expect(within(crumbs).getByText("Docs").getAttribute("aria-current")).toBe("page");
    expect(within(rowOf("plan.pdf")).getByRole("link", { name: "Download plan.pdf" }).getAttribute("href")).toBe(
      `/api/v1/admin/resources/${homes.id}/content?path=users%2Fbob%2FDocs%2Fplan.pdf`,
    );
  });

  it("never climbs above the home", async () => {
    const fetchMock = stubApi(handlers());
    renderApp(`${filesPage}?path=../alice`);
    await screen.findByRole("table");

    expect(requestsTo(fetchMock, entriesRoute).map((request) => request.url.searchParams.get("path"))).toEqual(["users/bob/alice"]);
  });

  it("uploads into the home's folder of the resource", async () => {
    stubApi(handlers());
    renderApp(`${filesPage}?path=Docs`);
    await screen.findByRole("table", { name: "Bob Builder / Docs" });

    fireEvent.change(screen.getByLabelText("Files to upload"), { target: { files: [new File(["1"], "a.txt")] } });
    await screen.findByRole("region", { name: "Uploading 1 file" });
    expect(tus.instances[0]?.options.metadata).toEqual({
      folder: "users/bob/Docs",
      name: "a.txt",
      onConflict: "fail",
      resourceId: homes.id,
    });
  });

  it("says when the home's resource is unavailable", async () => {
    const unavailable: Resource = { ...homes, state: "unavailable", unavailableReason: "missing" };
    const fetchMock = stubApi(handlers({ "GET /api/v1/admin/resources": () => json(200, { resources: [unavailable], homeRoot: null }) }));
    renderApp(filesPage);

    expect(await screen.findByText("Homes is unavailable")).toBeDefined();
    expect(screen.getByRole("button", { name: "Go to Resources" })).toBeDefined();
    expect(requestsTo(fetchMock, entriesRoute)).toHaveLength(0);
  });

  it("says when the home's resource is gone", async () => {
    stubApi(handlers({ "GET /api/v1/admin/resources": () => json(200, { resources: [], homeRoot: null }) }));
    renderApp(filesPage);

    expect(await screen.findByText("The resource of this home doesn't exist")).toBeDefined();
  });

  it("says when the user has no home folder", async () => {
    const fetchMock = stubApi(handlers({ [`GET /api/v1/admin/users/${bob.id}`]: () => json(200, { ...bob, home: null }) }));
    renderApp(filesPage);

    expect(await screen.findByRole("heading", { level: 1, name: "Files of Bob Builder" })).toBeDefined();
    expect(screen.getByText("No home folder")).toBeDefined();
    expect(requestsTo(fetchMock, entriesRoute)).toHaveLength(0);
  });

  it("says when the user doesn't exist", async () => {
    stubApi(handlers({ [`GET /api/v1/admin/users/${bob.id}`]: () => problem(404, problemTypes.notFound, "Not found") }));
    renderApp(filesPage);

    expect(await screen.findByText("This user doesn't exist")).toBeDefined();
    expect(screen.getByRole("button", { name: "Go to Users" })).toBeDefined();
  });

  it("says when the user could not be loaded, and loads them again on Try again", async () => {
    let fail = true;
    stubApi(
      handlers({
        [`GET /api/v1/admin/users/${bob.id}`]: () => (fail ? problem(403, problemTypes.forbidden, "Forbidden") : json(200, bob)),
      }),
    );
    renderApp(filesPage);

    expect(await screen.findByText("The user could not be loaded")).toBeDefined();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Bob Builder" })).toBeDefined();
  });
});
