import { problemTypes, type EntriesPage, type Entry, type Resource } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminSession,
  baseHandlers,
  json,
  noContent,
  problem,
  renderApp,
  requestsTo,
  stubApi,
  userSession,
  type MockHandler,
} from "../testing/index.ts";

interface FakeUpload {
  readonly file: File;
  readonly options: {
    metadata: { folder?: string; name?: string; onConflict?: string; resourceId?: string };
    onSuccess: () => void;
    onError: (error: Error) => void;
  };
}

const tus = vi.hoisted(() => ({ instances: [] as FakeUpload[] }));

vi.mock("tus-js-client", () => {
  class Upload {
    readonly start = vi.fn<() => void>();
    readonly abort = vi.fn<(terminate?: boolean) => Promise<void>>(() => Promise.resolve());
    readonly findPreviousUploads = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
    readonly resumeFromPreviousUpload = vi.fn<(previous: unknown) => void>();
    readonly file: File;
    readonly options: FakeUpload["options"];
    constructor(file: File, options: FakeUpload["options"]) {
      this.file = file;
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

const { uploadStoreFor } = await import("./upload-store.ts");
const { entrySortStorageKey } = await import("./sort.ts");

const modifiedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

const photos: Entry = { name: "Photos", kind: "folder", size: 0, modifiedAt };
const docs: Entry = { name: "Docs", kind: "folder", size: 0, modifiedAt };
const report: Entry = { name: "report.pdf", kind: "file", size: 2_500_000, modifiedAt };
const shortcut: Entry = { name: "elsewhere", kind: "link", size: 0, modifiedAt };
const holiday: Entry = { name: "holiday.jpg", kind: "file", size: 4_000_000, modifiedAt };

function page(path: string, entries: Entry[], nextCursor: string | null = null): EntriesPage {
  return { path, entries, nextCursor };
}

/** The home: the top folder holds Docs, Photos, report.pdf and a link; Photos holds holiday.jpg. */
function homeEntries(request: { readonly url: URL }): Response {
  const path = request.url.searchParams.get("path") ?? "";
  if (path === "Photos") return json(200, page("Photos", [holiday]));
  return json(200, page("", [docs, photos, report, shortcut]));
}

function userHandlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    ...baseHandlers({ session: userSession }),
    "GET /api/v1/home/entries": homeEntries,
    "GET /api/v1/home/quota": () => json(200, { usedBytes: 4_200_000_000, limitBytes: 10_000_000_000 }),
    ...extra,
  };
}

function rowNames(): string[] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table")).getByText(name).closest("tr");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
}

function chooseFiles(files: File[]): void {
  fireEvent.change(screen.getByLabelText("Files to upload"), { target: { files } });
}

function locationOf(router: { readonly state: { readonly location: { pathname: string; search: string } } }): string {
  return router.state.location.pathname + router.state.location.search;
}

/** Each listing's sort and order, as sent: "size desc". */
function sortsSent(fetchMock: ReturnType<typeof stubApi>, route = "GET /api/v1/home/entries"): string[] {
  return requestsTo(fetchMock, route).map(
    (request) => `${request.url.searchParams.get("sort") ?? ""} ${request.url.searchParams.get("order") ?? ""}`,
  );
}

function ariaSortOf(header: string): string | null {
  return screen.getByRole("columnheader", { name: header }).getAttribute("aria-sort");
}

afterEach(() => {
  const store = uploadStoreFor(userSession.account.id);
  for (const record of store.getSnapshot()) store.cancel(record.id);
  tus.instances.length = 0;
  localStorage.clear();
});

function query(path: string): string {
  return new URLSearchParams({ path }).toString();
}

describe("file browser (user)", () => {
  it("lists the home with folders first, sizes, relative times and the quota", async () => {
    stubApi(userHandlers());
    renderApp("/files");

    await screen.findByRole("table", { name: "Files" });
    expect(rowNames()).toEqual(["Docs", "Photos", "report.pdf", "elsewhereLink (not followed)"]);
    expect(within(rowOf("report.pdf")).getByText("2.5 MB")).toBeDefined();
    expect(within(rowOf("report.pdf")).getByText("2 hours ago")).toBeDefined();
    expect(within(rowOf("Photos")).getByText("—")).toBeDefined();
    // A link is never followed or deleted, so it has no actions.
    expect(screen.queryByRole("button", { name: "Actions for elsewhere" })).toBeNull();
    expect(screen.getByText("4.2 / 10 GB")).toBeDefined();
    expect(screen.getByRole("progressbar", { name: "Storage" })).toBeDefined();
    // At the top folder there is no path to show.
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("opens a folder by its link, with the path in the URL and Breadcrumbs back up", async () => {
    stubApi(userHandlers());
    const { router } = renderApp("/files");
    await screen.findByRole("table", { name: "Files" });

    fireEvent.click(within(rowOf("Photos")).getByRole("link", { name: "Photos" }));
    await screen.findByRole("table", { name: "Files / Photos" });
    expect(locationOf(router)).toBe("/files?path=Photos");
    expect(rowNames()).toEqual(["holiday.jpg"]);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByText("Photos").getAttribute("aria-current")).toBe("page");

    fireEvent.click(within(crumbs).getByRole("link", { name: "Files" }));
    await screen.findByRole("table", { name: "Files" });
    expect(locationOf(router)).toBe("/files");

    // Back and forward work: the path is in the history.
    await router.navigate(-1);
    await screen.findByRole("table", { name: "Files / Photos" });
  });

  it("downloads a file from its own row button, not from its name or the row menu", async () => {
    stubApi(userHandlers());
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });

    const row = rowOf("report.pdf");
    expect(within(row).queryByRole("link", { name: "report.pdf" })).toBeNull();
    expect(within(row).getByText("report.pdf").closest("a")).toBeNull();
    const download = within(row).getByRole("link", { name: "Download report.pdf" });
    expect(download.getAttribute("href")).toBe("/api/v1/home/content?path=report.pdf");
    expect(download.getAttribute("download")).toBe("report.pdf");

    fireEvent.click(within(row).getByRole("button", { name: "Actions for report.pdf" }));
    expect(screen.queryByRole("menuitem", { name: "Download" })).toBeNull();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Delete"]);
  });

  it("opens a folder from its name or its row menu, which has no Download", async () => {
    stubApi(userHandlers());
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });

    const row = rowOf("Docs");
    expect(within(row).queryByRole("link", { name: /^Download/ })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Actions for Docs" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Delete"]);
  });

  it("shows names that look like markup only as text (T4)", async () => {
    const image = "<img src=x onerror=alert(1)>.txt";
    const folder = '"><svg onload=alert(1)>';
    const link = "<script>alert(1)</script>";
    stubApi(
      userHandlers({
        "GET /api/v1/home/entries": () =>
          json(
            200,
            page("", [
              { ...docs, name: folder },
              { ...report, name: image },
              { ...shortcut, name: link },
            ]),
          ),
      }),
    );
    renderApp("/files");
    const table = await screen.findByRole("table", { name: "Files" });

    expect(rowNames()).toEqual([folder, image, `${link}Link (not followed)`]);
    expect(table.querySelector("img, svg[onload], script")).toBeNull();
    const download = within(table).getByRole("link", { name: `Download ${image}` });
    expect(download.getAttribute("href")).toBe(`/api/v1/home/content?${query(image)}`);
    expect(download.getAttribute("download")).toBe(image);
    expect(within(table).getByRole("link", { name: folder }).getAttribute("href")).toBe("/files?path=%22%3E%3Csvg%20onload%3Dalert(1)%3E");
    expect(screen.getByRole("button", { name: `Actions for ${image}` })).toBeDefined();
  });

  it("loads more entries with the next cursor", async () => {
    const fetchMock = stubApi(
      userHandlers({
        "GET /api/v1/home/entries": (request) =>
          request.url.searchParams.get("cursor") === "next" ? json(200, page("", [holiday])) : json(200, page("", [docs, report], "next")),
      }),
    );
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });
    expect(rowNames()).toEqual(["Docs", "report.pdf"]);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rowNames()).toEqual(["Docs", "report.pdf", "holiday.jpg"]));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(requestsTo(fetchMock, "GET /api/v1/home/entries").map((request) => request.url.searchParams.get("cursor"))).toEqual([
      null,
      "next",
    ]);
  });

  it("shows an empty state for an empty home", async () => {
    stubApi(userHandlers({ "GET /api/v1/home/entries": () => json(200, page("", [])) }));
    renderApp("/files");
    expect(await screen.findByText("No files yet")).toBeDefined();
  });

  it("deletes a folder with everything in it after a confirm", async () => {
    const fetchMock = stubApi(userHandlers({ "DELETE /api/v1/home/entries": () => noContent() }));
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });

    fireEvent.click(screen.getByRole("button", { name: "Actions for Photos" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Photos?" });
    expect(within(dialog).getByText(/Everything in this folder is deleted too/)).toBeDefined();
    expect(requestsTo(fetchMock, "DELETE /api/v1/home/entries")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete folder" }));

    expect(await screen.findByText("Folder deleted")).toBeDefined();
    const [request] = requestsTo(fetchMock, "DELETE /api/v1/home/entries");
    expect(request?.url.searchParams.get("path")).toBe("Photos");
    expect(request?.url.searchParams.get("recursive")).toBe("true");
  });

  it("deletes a file without recursive", async () => {
    const fetchMock = stubApi(userHandlers({ "DELETE /api/v1/home/entries": () => noContent() }));
    renderApp("/files?path=Photos");
    await screen.findByRole("table", { name: "Files / Photos" });

    fireEvent.click(screen.getByRole("button", { name: "Actions for holiday.jpg" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete holiday.jpg?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete file" }));

    expect(await screen.findByText("File deleted")).toBeDefined();
    const [request] = requestsTo(fetchMock, "DELETE /api/v1/home/entries");
    expect(request?.url.searchParams.get("path")).toBe("Photos/holiday.jpg");
    expect(request?.url.searchParams.get("recursive")).toBe("false");
  });

  it("creates a folder in the current one, and says when the name is taken", async () => {
    let answer = 0;
    const fetchMock = stubApi(
      userHandlers({
        "POST /api/v1/home/folders": () =>
          ++answer === 1 ? problem(409, problemTypes.nameTaken) : json(201, { name: "Trips", kind: "folder", size: 0, modifiedAt }),
      }),
    );
    renderApp("/files?path=Photos");
    await screen.findByRole("table", { name: "Files / Photos" });

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "Trips" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create folder" }));
    expect(await within(dialog).findByText("Something with this name is already in this folder.")).toBeDefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Create folder" }));
    expect(await screen.findByText("Folder created")).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/home/folders").map((request) => request.body)).toEqual([
      { path: "Photos", name: "Trips" },
      { path: "Photos", name: "Trips" },
    ]);
  });

  it("uploads chosen files into the current folder and says when one is complete", async () => {
    const fetchMock = stubApi(userHandlers());
    renderApp("/files?path=Photos");
    await screen.findByRole("table", { name: "Files / Photos" });

    chooseFiles([new File(["hello"], "notes.txt")]);
    const queue = await screen.findByRole("region", { name: "Uploading 1 file" });
    expect(within(queue).getByText("notes.txt")).toBeDefined();
    expect(within(queue).getByRole("button", { name: "Pause upload of notes.txt" })).toBeDefined();
    expect(within(queue).getByRole("button", { name: "Cancel upload of notes.txt" })).toBeDefined();
    const [upload] = tus.instances;
    expect(upload?.options.metadata).toEqual({ folder: "Photos", name: "notes.txt", onConflict: "fail" });

    const listings = requestsTo(fetchMock, "GET /api/v1/home/entries").length;
    upload?.options.onSuccess();
    expect(await screen.findByText("Upload complete")).toBeDefined();
    await waitFor(() => expect(requestsTo(fetchMock, "GET /api/v1/home/entries").length).toBeGreaterThan(listings));
    expect(screen.getByRole("region", { name: "Uploads" })).toBeDefined();
  });

  it("asks Replace or Keep both when an upload's name is taken, and restarts it with the choice", async () => {
    stubApi(userHandlers());
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });

    chooseFiles([new File(["%PDF"], "report.pdf")]);
    await screen.findByRole("region", { name: "Uploading 1 file" });
    const conflict = Object.assign(new Error("tus"), {
      originalRequest: {},
      originalResponse: {
        getStatus: () => 409,
        getHeader: () => undefined,
        getBody: () => JSON.stringify({ type: problemTypes.nameTaken, title: "Name taken", status: 409 }),
      },
    });
    tus.instances[0]?.options.onError(conflict);

    const dialog = await screen.findByRole("dialog", { name: "Replace report.pdf?" });
    expect(within(dialog).getByRole("button", { name: "Keep both" })).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace file" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Replace report.pdf?" })).toBeNull());
    expect(tus.instances).toHaveLength(2);
    expect(tus.instances[1]?.options.metadata).toEqual({ folder: "", name: "report.pdf", onConflict: "replace" });
  });
});

describe("file browser sorting", () => {
  it("lists by name A→Z with nothing remembered, shown on the Name header", async () => {
    const fetchMock = stubApi(userHandlers());
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });

    expect(sortsSent(fetchMock)).toEqual(["name asc"]);
    expect(ariaSortOf("Name")).toBe("ascending");
    expect(ariaSortOf("Size")).toBeNull();
    expect(ariaSortOf("Modified")).toBeNull();
    // Only the entry columns sort.
    expect(within(screen.getByRole("columnheader", { name: "Actions" })).queryByRole("button")).toBeNull();
  });

  it("starts a column in its own order and flips the sorted one, listing again from the first page", async () => {
    const fetchMock = stubApi(
      userHandlers({
        "GET /api/v1/home/entries": (request) =>
          request.url.searchParams.get("cursor") === "next" ? json(200, page("", [holiday])) : json(200, page("", [docs, report], "next")),
      }),
    );
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rowNames()).toEqual(["Docs", "report.pdf", "holiday.jpg"]));

    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    await waitFor(() => expect(ariaSortOf("Size")).toBe("descending"));
    await waitFor(() => expect(rowNames()).toEqual(["Docs", "report.pdf"]));
    expect(ariaSortOf("Name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    await waitFor(() => expect(ariaSortOf("Size")).toBe("ascending"));
    fireEvent.click(screen.getByRole("button", { name: "Modified" }));
    await waitFor(() => expect(ariaSortOf("Modified")).toBe("descending"));
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(ariaSortOf("Name")).toBe("ascending"));

    // A new sort lists from its first page; back at name A→Z, its two cached pages are reloaded with their own cursor.
    const sent = () =>
      requestsTo(fetchMock, "GET /api/v1/home/entries").map((request) =>
        ["sort", "order", "cursor"].map((name) => request.url.searchParams.get(name) ?? "-").join(" "),
      );
    await waitFor(() =>
      expect(sent()).toEqual([
        "name asc -",
        "name asc next",
        "size desc -",
        "size asc -",
        "modified desc -",
        "name asc -",
        "name asc next",
      ]),
    );
  });

  it("remembers the sort from folder to folder and across reloads", async () => {
    const fetchMock = stubApi(userHandlers());
    const first = renderApp("/files");
    await screen.findByRole("table", { name: "Files" });
    fireEvent.click(screen.getByRole("button", { name: "Modified" }));
    await waitFor(() => expect(ariaSortOf("Modified")).toBe("descending"));
    expect(JSON.parse(localStorage.getItem(entrySortStorageKey) ?? "null")).toEqual({ key: "modified", order: "desc" });

    fireEvent.click(within(rowOf("Photos")).getByRole("link", { name: "Photos" }));
    await screen.findByRole("table", { name: "Files / Photos" });
    expect(ariaSortOf("Modified")).toBe("descending");

    first.view.unmount();
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });
    expect(ariaSortOf("Modified")).toBe("descending");
    expect(sortsSent(fetchMock)).toEqual(["name asc", "modified desc", "modified desc", "modified desc"]);
  });

  it.each([
    ["no JSON", "{size"],
    ["an unknown column", JSON.stringify({ key: "owner", order: "asc" })],
    ["an unknown order", JSON.stringify({ key: "size", order: "up" })],
  ])("falls back to name A→Z when the stored sort has %s", async (_, stored) => {
    localStorage.setItem(entrySortStorageKey, stored);
    const fetchMock = stubApi(userHandlers());
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });

    expect(ariaSortOf("Name")).toBe("ascending");
    expect(sortsSent(fetchMock)).toEqual(["name asc"]);
  });

  it("still sorts when storage is refused", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Refused", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Refused", "SecurityError");
    });
    const fetchMock = stubApi(userHandlers());
    renderApp("/files");
    await screen.findByRole("table", { name: "Files" });
    expect(ariaSortOf("Name")).toBe("ascending");

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(ariaSortOf("Name")).toBe("descending"));
    expect(sortsSent(fetchMock)).toEqual(["name asc", "name desc"]);
  });
});

describe("file browser (admin)", () => {
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
  const entriesPath = `/api/v1/admin/resources/${media.id}/entries`;

  function adminHandlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
    return {
      ...baseHandlers({ session: adminSession }),
      "GET /api/v1/admin/resources": () => json(200, { resources: [media], homeRoot: null }),
      [`GET ${entriesPath}`]: () => json(200, page("", [docs, report])),
      ...extra,
    };
  }

  afterEach(() => {
    const store = uploadStoreFor(adminSession.account.id);
    for (const record of store.getSnapshot()) store.cancel(record.id);
  });

  it("opens the first available resource from /admin/files and lists it, with Files in the Sidebar", async () => {
    stubApi(adminHandlers());
    const { router } = renderApp("/admin/files");

    await screen.findByRole("table", { name: "Media" });
    expect(locationOf(router)).toBe(`/admin/files/${media.id}`);
    expect(rowNames()).toEqual(["Docs", "report.pdf"]);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Files" }).getAttribute("aria-current")).toBe("page");
    expect(within(rowOf("report.pdf")).getByRole("link", { name: "Download report.pdf" }).getAttribute("href")).toBe(
      `/api/v1/admin/resources/${media.id}/content?path=report.pdf`,
    );
  });

  it("uploads into the resource with its id", async () => {
    stubApi(adminHandlers());
    renderApp(`/admin/files/${media.id}?path=Docs`);
    await screen.findByRole("table", { name: "Media / Docs" });

    chooseFiles([new File(["1"], "a.txt")]);
    await screen.findByRole("region", { name: "Uploading 1 file" });
    expect(tus.instances[0]?.options.metadata).toEqual({ folder: "Docs", name: "a.txt", onConflict: "fail", resourceId: media.id });
  });

  it("deletes a folder of a resource with recursive", async () => {
    const fetchMock = stubApi(adminHandlers({ [`DELETE ${entriesPath}`]: () => noContent() }));
    renderApp(`/admin/files/${media.id}`);
    await screen.findByRole("table", { name: "Media" });

    fireEvent.click(screen.getByRole("button", { name: "Actions for Docs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete Docs?" })).getByRole("button", { name: "Delete folder" }));

    expect(await screen.findByText("Folder deleted")).toBeDefined();
    const [request] = requestsTo(fetchMock, `DELETE ${entriesPath}`);
    expect(request?.url.searchParams.get("recursive")).toBe("true");
  });

  it("lists a resource in the remembered sort too", async () => {
    localStorage.setItem(entrySortStorageKey, JSON.stringify({ key: "size", order: "desc" }));
    const fetchMock = stubApi(adminHandlers());
    renderApp(`/admin/files/${media.id}`);
    await screen.findByRole("table", { name: "Media" });

    expect(ariaSortOf("Size")).toBe("descending");
    expect(sortsSent(fetchMock, `GET ${entriesPath}`)).toEqual(["size desc"]);
  });

  it("switches resources with the Resource picker, each worded by its kind and location", async () => {
    const nas: Resource = {
      id: "5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d04",
      kind: "smb",
      name: "NAS",
      host: "nas.local",
      share: "files",
      subfolder: "family",
      username: "alice",
      domain: "",
      protocol: "3.1.1",
      encrypt: true,
      smbPasswordSet: true,
      state: "available",
      unavailableReason: null,
      isHomeRoot: false,
      createdAt: "2026-11-22T10:00:00.000Z",
    };
    stubApi(
      adminHandlers({
        "GET /api/v1/admin/resources": () => json(200, { resources: [media, nas], homeRoot: null }),
        [`GET /api/v1/admin/resources/${nas.id}/entries`]: () => json(200, page("", [report])),
      }),
    );
    const { router } = renderApp(`/admin/files/${media.id}`);
    await screen.findByRole("table", { name: "Media" });

    const picker = screen.getByRole("combobox", { name: "Resource" });
    expect(picker.textContent).toBe("Media");
    fireEvent.click(picker);
    expect(screen.getByRole("option", { name: /^Media/ }).textContent).toContain("Local folder · /srv/media");
    const nasOption = screen.getByRole("option", { name: /^NAS/ });
    expect(nasOption.textContent).toContain("SMB share · //nas.local/files/family");
    fireEvent.click(nasOption);

    await screen.findByRole("table", { name: "NAS" });
    expect(locationOf(router)).toBe(`/admin/files/${nas.id}`);
    expect(screen.getByRole("combobox", { name: "Resource" }).textContent).toBe("NAS");
  });

  it("says when there is no resource to browse", async () => {
    stubApi(adminHandlers({ "GET /api/v1/admin/resources": () => json(200, { resources: [], homeRoot: null }) }));
    renderApp("/admin/files");
    expect(await screen.findByText("No resources to browse")).toBeDefined();
  });
});
