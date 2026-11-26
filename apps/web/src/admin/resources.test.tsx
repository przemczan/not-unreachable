import { problemTypes, type Resource, type ResourceList } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminSession,
  baseHandlers,
  json,
  noContent,
  problem,
  renderApp,
  requestsTo,
  stubApi,
  type MockHandler,
} from "../testing/index.ts";
import { allowFolderTiming } from "./allow-folder-dialog.tsx";

const media: Resource = {
  id: "5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d01",
  kind: "local",
  name: "Media",
  localPath: "/srv/media",
  state: "available",
  unavailableReason: null,
  isHomeRoot: true,
  createdAt: "2026-11-20T10:00:00.000Z",
};

const archive: Resource = {
  id: "5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d02",
  kind: "local",
  name: "Archive",
  localPath: "/mnt/archive",
  state: "unavailable",
  unavailableReason: "changed",
  isHomeRoot: false,
  createdAt: "2026-11-21T10:00:00.000Z",
};

const spare: Resource = {
  ...archive,
  id: "5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d03",
  name: "Spare",
  localPath: "/srv/spare",
  state: "available",
  unavailableReason: null,
};

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

const oldNas: Resource = {
  ...nas,
  id: "5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d05",
  name: "Old NAS",
  host: "192.168.1.20",
  subfolder: "",
  protocol: "2.1",
  encrypt: false,
  state: "unavailable",
  unavailableReason: "auth",
};

const warning = "Traffic to this share is not encrypted";

function handlers(list: ResourceList, extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return { ...baseHandlers({ session: adminSession }), "GET /api/v1/admin/resources": () => json(200, list), ...extra };
}

async function openPage(): Promise<void> {
  renderApp("/admin/resources");
  await screen.findByRole("heading", { level: 1, name: "Resources" });
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Resources" }))
    .getByText(name)
    .closest("tr");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
}

/** Opens the PageHeader's "Add resource" Menu (the empty state has one too) and picks a kind. */
async function addResource(kind: "Local folder" | "SMB share"): Promise<HTMLElement> {
  const [button] = await screen.findAllByRole("button", { name: "Add resource" });
  if (button === undefined) throw new Error("No Add resource button");
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: kind }));
  return screen.findByRole("dialog", { name: kind === "SMB share" ? "Add SMB share" : "Add folder" });
}

function type(container: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(container).getByLabelText(label), { target: { value } });
}

/** Answers "Check folder" with each answer in turn, the last one from then on. */
function checks(...answers: object[]): MockHandler {
  let index = 0;
  return () => json(200, answers[Math.min(index++, answers.length - 1)]);
}

/** The health check: down, as behind a proxy, until `up()` is called. */
function health() {
  let isUp = false;
  const handler: MockHandler = () => (isUp ? json(200, { status: "ok" }) : problem(503, "about:blank", "Service Unavailable"));
  return {
    handler,
    up: () => {
      isUp = true;
    },
  };
}

function enterCode(code: string, container: HTMLElement): void {
  fireEvent.change(within(container).getByRole("textbox", { name: "Digit 1 of 6" }), { target: { value: code } });
}

/** Opens the Drawer, checks /srv/spare and opens "Allow this folder". */
async function openAllowDialog(): Promise<{ drawer: HTMLElement; dialog: HTMLElement }> {
  await openPage();
  const drawer = await addResource("Local folder");
  type(drawer, "Folder path", "/srv/spare");
  fireEvent.click(within(drawer).getByRole("button", { name: "Check folder" }));
  fireEvent.click(await within(drawer).findByRole("button", { name: "Allow this folder" }));
  return { drawer, dialog: await screen.findByRole("dialog", { name: "Allow this folder" }) };
}

function allowWith(dialog: HTMLElement, password: string, code: string): void {
  type(dialog, "Password", password);
  enterCode(code, dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Allow and restart" }));
}

function folderEntry(name: string) {
  return { name, kind: "folder", size: 0, modifiedAt: "2026-11-20T10:00:00.000Z" };
}

function fileEntry(name: string) {
  return { ...folderEntry(name), kind: "file", size: 10 };
}

/** The folders of /srv/spare by path; the top folder's in two pages. A path not here is missing. */
const spareListing: MockHandler = ({ url }) => {
  const path = url.searchParams.get("path") ?? "";
  const cursor = url.searchParams.get("cursor");
  if (path === "" && cursor === null) {
    return json(200, { path, entries: [folderEntry("Homes"), folderEntry("people"), fileEntry("hosts.txt")], nextCursor: "page-2" });
  }
  if (path === "") return json(200, { path, entries: [folderEntry("home-old"), fileEntry("readme.md")], nextCursor: null });
  if (path === "people")
    return json(200, { path, entries: [folderEntry("staff"), folderEntry("guests"), fileEntry("list.csv")], nextCursor: null });
  return problem(422, problemTypes.pathRefused, "Path refused", undefined, { reason: "not-found" });
};

function subfolderField(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("combobox", { name: "Subfolder" });
}

/** The names the Subfolder suggests now. */
function suggested(): (string | null)[] {
  return screen.queryAllByRole("option").map((option) => option.textContent);
}

describe("resources", () => {
  it("lists each resource with its path, status, the reason it is unavailable and the home root", async () => {
    stubApi(handlers({ resources: [media, archive], homeRoot: { resourceId: media.id, subpath: "homes" } }));
    await openPage();

    const table = await screen.findByRole("table", { name: "Resources" });
    expect(within(table).getByText("/srv/media")).toBeDefined();
    const mediaRow = rowOf("Media");
    expect(within(mediaRow).getByText("Available")).toBeDefined();
    expect(within(mediaRow).getByText("Home root")).toBeDefined();
    const archiveRow = rowOf("Archive");
    expect(within(archiveRow).getByText("Unavailable")).toBeDefined();
    expect(within(archiveRow).getByText("Folder changed since it was saved")).toBeDefined();
    expect(screen.queryByText("No home root yet")).toBeNull();
  });

  it("adds a folder from the Drawer", async () => {
    const fetchMock = stubApi(
      handlers({ resources: [], homeRoot: null }, { "POST /api/v1/admin/resources": () => json(201, { ...spare, name: "Files" }) }),
    );
    await openPage();
    expect(await screen.findByText("No resources yet")).toBeDefined();
    expect(screen.getByText("Users can't be invited until a home root is chosen.")).toBeDefined();

    const drawer = await addResource("Local folder");
    type(drawer, "Name", "Files");
    type(drawer, "Folder path", "/srv/spare");
    fireEvent.click(within(drawer).getByRole("button", { name: "Add folder" }));

    expect(await screen.findByText("Folder added")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add folder" })).toBeNull());
    expect(requestsTo(fetchMock, "POST /api/v1/admin/resources").map((request) => request.body)).toEqual([
      { kind: "local", name: "Files", localPath: "/srv/spare" },
    ]);
  });

  it("shows the exact allow-folder command when the service can't write to the folder", async () => {
    const command = "sudo not-unreachable allow-folder /srv/spare";
    const fetchMock = stubApi(
      handlers(
        { resources: [], homeRoot: null },
        {
          "POST /api/v1/admin/resources/checks": () =>
            json(200, { outcome: "refused", reason: "not-writable", command, allowFromUi: false }),
        },
      ),
    );
    await openPage();

    const drawer = await addResource("Local folder");
    type(drawer, "Folder path", "/srv/spare");
    fireEvent.click(within(drawer).getByRole("button", { name: "Check folder" }));

    expect(await within(drawer).findByText("The service can't write to this folder")).toBeDefined();
    expect(within(drawer).getByText("Run this command on the server, then check the folder again.")).toBeDefined();
    expect(
      within(drawer).getByText("If the command doesn't help, the not-unreachable user needs write permission on the folder."),
    ).toBeDefined();
    expect(within(drawer).queryByRole("button", { name: "Allow this folder" })).toBeNull();
    const field = within(drawer).getByRole("group", { name: "Command" });
    expect(field.querySelector("code")?.textContent).toBe(command);
    expect(within(field).getByRole("button", { name: "Copy command" })).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/admin/resources/checks").map((request) => request.body)).toEqual([
      { kind: "local", localPath: "/srv/spare" },
    ]);
  });

  it("shows a refused save in words and a taken name on the Name field", async () => {
    let answer = 0;
    stubApi(
      handlers(
        { resources: [], homeRoot: null },
        {
          "POST /api/v1/admin/resources": () =>
            ++answer === 1
              ? problem(422, problemTypes.folderRefused, "Refused", undefined, { reason: "missing" })
              : problem(409, problemTypes.resourceNameTaken),
        },
      ),
    );
    await openPage();
    const drawer = await addResource("Local folder");
    type(drawer, "Name", "Files");
    type(drawer, "Folder path", "/srv/nothing");

    fireEvent.click(within(drawer).getByRole("button", { name: "Add folder" }));
    expect(await within(drawer).findByText("There is no folder at this path on the server.")).toBeDefined();

    fireEvent.click(within(drawer).getByRole("button", { name: "Add folder" }));
    expect(await within(drawer).findByText("Another resource already has this name.")).toBeDefined();
  });

  it("removes a resource after the confirm, and never offers to remove the home root's", async () => {
    const fetchMock = stubApi(
      handlers(
        { resources: [media, archive], homeRoot: { resourceId: media.id, subpath: "" } },
        { [`DELETE /api/v1/admin/resources/${archive.id}`]: () => noContent() },
      ),
    );
    await openPage();
    await screen.findByRole("table", { name: "Resources" });

    fireEvent.click(screen.getByRole("button", { name: "Actions for Media" }));
    expect(screen.getByRole<HTMLButtonElement>("menuitem", { name: "Holds the home root: can't be removed" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Media" }));

    fireEvent.click(screen.getByRole("button", { name: "Actions for Archive" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Archive?" });
    expect(within(dialog).getByText(/Nothing on disk is deleted/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove resource" }));

    expect(await screen.findByText("Resource removed")).toBeDefined();
    expect(requestsTo(fetchMock, `DELETE /api/v1/admin/resources/${archive.id}`)).toHaveLength(1);
  });

  it("says why the server kept a resource that holds users' homes", async () => {
    stubApi(
      handlers(
        { resources: [media, spare], homeRoot: { resourceId: media.id, subpath: "" } },
        {
          [`DELETE /api/v1/admin/resources/${spare.id}`]: () =>
            problem(409, problemTypes.homeRootResource, "In use", undefined, { reason: "holds-homes" }),
        },
      ),
    );
    await openPage();
    await screen.findByRole("table", { name: "Resources" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Spare" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Spare?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove resource" }));

    expect(await within(dialog).findByText("Users' homes are in this resource, so it can't be removed.")).toBeDefined();
  });

  it("sets the home root after a confirm saying existing homes stay where they are", async () => {
    const fetchMock = stubApi(
      handlers(
        { resources: [spare, archive], homeRoot: null },
        { "PUT /api/v1/admin/home-root": () => json(200, { resourceId: spare.id, subpath: "homes" }) },
      ),
    );
    await openPage();

    const group = await screen.findByRole("radiogroup", { name: "Home root" });
    expect(within(group).getByRole<HTMLInputElement>("radio", { name: "Archive" }).disabled).toBe(true);
    fireEvent.click(within(group).getByRole("radio", { name: "Spare" }));
    fireEvent.change(screen.getByLabelText("Subfolder"), { target: { value: "homes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save home root" }));

    const dialog = await screen.findByRole("dialog", { name: "Set the home root?" });
    expect(within(dialog).getByText(/Existing homes stay where they are/)).toBeDefined();
    expect(requestsTo(fetchMock, "PUT /api/v1/admin/home-root")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save home root" }));

    expect(await screen.findByText("Home root saved")).toBeDefined();
    expect(requestsTo(fetchMock, "PUT /api/v1/admin/home-root").map((request) => request.body)).toEqual([
      { resourceId: spare.id, subpath: "homes" },
    ]);
  });
  describe("suggesting the home root's subfolder", () => {
    const entriesRoute = `GET /api/v1/admin/resources/${spare.id}/entries`;

    async function openWithSpare(extra: Record<string, MockHandler> = {}) {
      const fetchMock = stubApi(handlers({ resources: [spare, archive], homeRoot: null }, { [entriesRoute]: spareListing, ...extra }));
      await openPage();
      fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Home root" })).getByRole("radio", { name: "Spare" }));
      return fetchMock;
    }

    it("suggests the folders, not the files, of the folder typed so far, filtered by what follows the last /", async () => {
      const fetchMock = await openWithSpare();
      fireEvent.change(subfolderField(), { target: { value: "h" } });
      await waitFor(() => expect(suggested()).toEqual(["home-old", "Homes"]));
      expect(subfolderField().getAttribute("aria-expanded")).toBe("true");

      fireEvent.change(subfolderField(), { target: { value: "" } });
      expect(suggested()).toEqual(["home-old", "Homes", "people"]);
      fireEvent.change(subfolderField(), { target: { value: "HOMES" } });
      expect(suggested()).toEqual(["Homes"]);
      // Both pages of the top folder, once: typing again doesn't read it again.
      expect(requestsTo(fetchMock, entriesRoute)).toHaveLength(2);
    });

    it("goes down a level when a folder is chosen, and saves the path without its trailing /", async () => {
      const fetchMock = await openWithSpare({
        "PUT /api/v1/admin/home-root": () => json(200, { resourceId: spare.id, subpath: "people/staff" }),
      });
      fireEvent.change(subfolderField(), { target: { value: "pe" } });
      fireEvent.click(await screen.findByRole("option", { name: "people" }));
      expect(subfolderField().value).toBe("people/");
      await waitFor(() => expect(suggested()).toEqual(["guests", "staff"]));

      fireEvent.keyDown(subfolderField(), { key: "ArrowDown" });
      fireEvent.keyDown(subfolderField(), { key: "ArrowDown" });
      fireEvent.keyDown(subfolderField(), { key: "Enter" });
      expect(subfolderField().value).toBe("people/staff/");
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Save home root" }));
      const dialog = await screen.findByRole("dialog", { name: "Set the home root?" });
      expect(within(dialog).getByText("people/staff")).toBeDefined();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save home root" }));
      expect(await screen.findByText("Home root saved")).toBeDefined();
      expect(requestsTo(fetchMock, "PUT /api/v1/admin/home-root").map((request) => request.body)).toEqual([
        { resourceId: spare.id, subpath: "people/staff" },
      ]);
    });

    it("suggests nothing, and shows no error, for a folder that doesn't exist yet, which can still be saved", async () => {
      const fetchMock = await openWithSpare({
        "PUT /api/v1/admin/home-root": () => json(200, { resourceId: spare.id, subpath: "new/homes" }),
      });
      fireEvent.change(subfolderField(), { target: { value: "new/ho" } });
      await waitFor(() =>
        expect(requestsTo(fetchMock, entriesRoute).some((request) => request.url.searchParams.get("path") === "new")).toBe(true),
      );
      await waitFor(() => expect(subfolderField().getAttribute("aria-expanded")).toBe("false"));
      expect(suggested()).toEqual([]);
      expect(subfolderField().getAttribute("aria-invalid")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();

      fireEvent.change(subfolderField(), { target: { value: "new/homes" } });
      fireEvent.click(screen.getByRole("button", { name: "Save home root" }));
      fireEvent.click(
        within(await screen.findByRole("dialog", { name: "Set the home root?" })).getByRole("button", { name: "Save home root" }),
      );
      expect(await screen.findByText("Home root saved")).toBeDefined();
    });

    it("lists nothing until an available resource is chosen", async () => {
      const fetchMock = stubApi(handlers({ resources: [spare, archive], homeRoot: null }, { [entriesRoute]: spareListing }));
      await openPage();
      await screen.findByRole("radiogroup", { name: "Home root" });
      fireEvent.change(subfolderField(), { target: { value: "h" } });
      expect(suggested()).toEqual([]);
      expect(subfolderField().getAttribute("aria-expanded")).toBe("false");
      expect(requestsTo(fetchMock, entriesRoute)).toHaveLength(0);
    });
  });

  describe("allowing a folder from here", () => {
    const command = "sudo not-unreachable allow-folder /srv/spare";
    const notWritable = { outcome: "refused", reason: "not-writable", command, allowFromUi: true };
    const restarting = "Restarting the service… This takes a few seconds.";
    const timing = { ...allowFolderTiming };

    beforeEach(() => {
      Object.assign(allowFolderTiming, { firstCheckMs: 1, checkEveryMs: 5, settleMs: 20, giveUpMs: 300 });
    });

    afterEach(() => {
      Object.assign(allowFolderTiming, timing);
    });

    it("offers Allow this folder beside the command when the server allows it", async () => {
      stubApi(handlers({ resources: [], homeRoot: null }, { "POST /api/v1/admin/resources/checks": checks(notWritable) }));
      const { drawer, dialog } = await openAllowDialog();

      expect(
        within(drawer).getByText(
          "Allow the service to write to it from here, or run this command on the server, then check the folder again.",
        ),
      ).toBeDefined();
      expect(within(drawer).getByRole("group", { name: "Command" }).querySelector("code")?.textContent).toBe(command);
      expect(within(dialog).getByText("/srv/spare")).toBeDefined();
      expect(document.activeElement).toBe(within(dialog).getByLabelText("Password"));
    });

    it("asks for the password and a 6-digit code, and says when either is wrong", async () => {
      let answer = 0;
      const fetchMock = stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources/checks": checks(notWritable),
            "POST /api/v1/admin/resources/allowed-folders": () =>
              ++answer === 1 ? problem(401, problemTypes.signInFailed) : problem(401, problemTypes.secondFactorFailed),
          },
        ),
      );
      const { dialog } = await openAllowDialog();

      fireEvent.click(within(dialog).getByRole("button", { name: "Allow and restart" }));
      expect(await within(dialog).findByText("Enter your password.")).toBeDefined();
      type(dialog, "Password", "wrong");
      fireEvent.click(within(dialog).getByRole("button", { name: "Allow and restart" }));
      expect(await within(dialog).findByText("Enter the 6-digit code from your authenticator app.")).toBeDefined();
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources/allowed-folders")).toHaveLength(0);

      allowWith(dialog, "wrong", "123456");
      expect(await within(dialog).findByText("The password is not right.")).toBeDefined();

      allowWith(dialog, "right", "000000");
      expect(await within(dialog).findByText("The code is not right. Check the code in your app and try again.")).toBeDefined();
      expect(within(dialog).getByRole("textbox", { name: "Digit 1 of 6" })).toHaveProperty("value", "");
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources/allowed-folders").map((request) => request.body)).toEqual([
        { localPath: "/srv/spare", reauthentication: { password: "wrong", secondFactor: { code: "123456" } } },
        { localPath: "/srv/spare", reauthentication: { password: "right", secondFactor: { code: "000000" } } },
      ]);
    });

    it("waits for the service to restart, then checks the folder again", async () => {
      const service = health();
      const fetchMock = stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources/checks": checks(notWritable, { outcome: "ok" }),
            "POST /api/v1/admin/resources/allowed-folders": () => new Response(null, { status: 202 }),
            "GET /api/v1/health": service.handler,
          },
        ),
      );
      const { drawer, dialog } = await openAllowDialog();
      allowWith(dialog, "right", "123456");

      expect(await within(dialog).findByText(restarting)).toBeDefined();
      expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
      await waitFor(() => expect(requestsTo(fetchMock, "GET /api/v1/health").length).toBeGreaterThan(0));
      service.up();

      expect(await within(drawer).findByText("The service can use this folder")).toBeDefined();
      expect(screen.queryByRole("dialog", { name: "Restarting the service" })).toBeNull();
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources/checks")).toHaveLength(2);
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources")).toHaveLength(0);
    });

    it("goes on adding the folder once it is allowed, when adding it was refused", async () => {
      let added = 0;
      const service = health();
      const fetchMock = stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources": () =>
              ++added === 1
                ? problem(422, problemTypes.folderRefused, "Refused", undefined, { reason: "not-writable", command, allowFromUi: true })
                : json(201, { ...spare, name: "Files" }),
            "POST /api/v1/admin/resources/checks": checks({ outcome: "ok" }),
            "POST /api/v1/admin/resources/allowed-folders": () => new Response(null, { status: 202 }),
            "GET /api/v1/health": service.handler,
          },
        ),
      );
      await openPage();
      const drawer = await addResource("Local folder");
      type(drawer, "Name", "Files");
      type(drawer, "Folder path", "/srv/spare");
      fireEvent.click(within(drawer).getByRole("button", { name: "Add folder" }));
      fireEvent.click(await within(drawer).findByRole("button", { name: "Allow this folder" }));
      const dialog = await screen.findByRole("dialog", { name: "Allow this folder" });
      allowWith(dialog, "right", "123456");
      await within(dialog).findByText(restarting);
      service.up();

      expect(await screen.findByText("Folder added")).toBeDefined();
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add folder" })).toBeNull());
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources").map((request) => request.body)).toEqual([
        { kind: "local", name: "Files", localPath: "/srv/spare" },
        { kind: "local", name: "Files", localPath: "/srv/spare" },
      ]);
    });

    it("shows what the server says to run when it can't allow folders", async () => {
      const detail = "Allowing folders from here isn't set up. Run the install script again on the server.";
      stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources/checks": checks(notWritable),
            "POST /api/v1/admin/resources/allowed-folders": () => problem(503, problemTypes.serviceUnavailable, "Unavailable", detail),
          },
        ),
      );
      const { dialog } = await openAllowDialog();
      allowWith(dialog, "right", "123456");

      expect(await within(dialog).findByText(detail)).toBeDefined();
    });

    it("says why a folder can't be allowed from here", async () => {
      stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources/checks": checks(notWritable),
            "POST /api/v1/admin/resources/allowed-folders": () =>
              problem(422, problemTypes.folderNotAllowable, "Not allowable", undefined, { reason: "system-folder" }),
          },
        ),
      );
      const { dialog } = await openAllowDialog();
      allowWith(dialog, "right", "123456");

      expect(
        await within(dialog).findByText("This is a system folder, or holds one, so it can't be allowed from here. Choose another folder."),
      ).toBeDefined();
    });

    it("shows only the command once allowing from here is turned off", async () => {
      stubApi(handlers({ resources: [], homeRoot: null }, { "POST /api/v1/admin/resources/checks": checks(notWritable) }));
      const { drawer, dialog } = await openAllowDialog();
      allowWith(dialog, "right", "123456");

      expect(await within(dialog).findByText("Allowing folders from here is turned off")).toBeDefined();
      expect(within(dialog).getByRole("group", { name: "Command" }).querySelector("code")?.textContent).toBe(command);
      // The footer's Close, after the title's.
      const close = within(dialog).getAllByRole("button", { name: "Close" }).at(-1);
      if (close === undefined) throw new Error("No Close button");
      fireEvent.click(close);
      await waitFor(() => expect(within(drawer).queryByRole("button", { name: "Allow this folder" })).toBeNull());
      expect(within(drawer).getByText("Run this command on the server, then check the folder again.")).toBeDefined();
    });

    it("takes a dropped connection as the restart", async () => {
      const service = health();
      stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources/checks": checks(notWritable, { outcome: "ok" }),
            "POST /api/v1/admin/resources/allowed-folders": () => Promise.reject(new TypeError("Failed to fetch")),
            "GET /api/v1/health": service.handler,
          },
        ),
      );
      const { drawer, dialog } = await openAllowDialog();
      allowWith(dialog, "right", "123456");

      expect(await within(dialog).findByText(restarting)).toBeDefined();
      service.up();
      expect(await within(drawer).findByText("The service can use this folder")).toBeDefined();
    });

    it("says when the service doesn't come back, and waits again on Retry", async () => {
      const service = health();
      const fetchMock = stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources/checks": checks(notWritable, { outcome: "ok" }),
            "POST /api/v1/admin/resources/allowed-folders": () => new Response(null, { status: 202 }),
            "GET /api/v1/health": service.handler,
          },
        ),
      );
      const { drawer, dialog } = await openAllowDialog();
      allowWith(dialog, "right", "123456");

      expect(await within(dialog).findByText("The service didn't come back")).toBeDefined();
      expect(within(dialog).getByText("journalctl -u not-unreachable")).toBeDefined();
      const checked = requestsTo(fetchMock, "GET /api/v1/health").length;

      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
      expect(await within(dialog).findByText(restarting)).toBeDefined();
      await waitFor(() => expect(requestsTo(fetchMock, "GET /api/v1/health").length).toBeGreaterThan(checked));
      service.up();
      expect(await within(drawer).findByText("The service can use this folder")).toBeDefined();
    });
  });

  describe("SMB shares", () => {
    it("lists a share by its address, with the warning when its traffic isn't encrypted", async () => {
      stubApi(handlers({ resources: [nas, oldNas], homeRoot: null }));
      await openPage();
      await screen.findByRole("table", { name: "Resources" });

      const nasRow = rowOf("NAS");
      expect(within(nasRow).getByText("//nas.local/files/family")).toBeDefined();
      expect(within(nasRow).queryByText(warning)).toBeNull();
      const oldRow = rowOf("Old NAS");
      expect(within(oldRow).getByText("//192.168.1.20/files")).toBeDefined();
      expect(within(oldRow).getByText(warning)).toBeDefined();
      expect(within(oldRow).getByText("Sign-in refused")).toBeDefined();
    });

    it("adds a share, warning in the form when encryption is turned off", async () => {
      const fetchMock = stubApi(
        handlers({ resources: [], homeRoot: null }, { "POST /api/v1/admin/resources": () => json(201, { ...nas, encrypt: false }) }),
      );
      await openPage();
      const drawer = await addResource("SMB share");
      expect(within(drawer).queryByText(warning)).toBeNull();
      expect(within(drawer).getByRole<HTMLSelectElement>("combobox", { name: "Protocol" }).value).toBe("3.1.1");

      type(drawer, "Name", "NAS");
      type(drawer, "Server", "nas.local");
      type(drawer, "Share", "files");
      type(drawer, "Folder in share", "/family/");
      type(drawer, "Username", "alice");
      type(drawer, "Password", "s3cret pass");
      const encrypt = within(drawer).getByRole<HTMLInputElement>("switch", { name: /Encrypt traffic/ });
      expect(encrypt.checked).toBe(true);
      fireEvent.click(encrypt);
      expect(within(drawer).getByText(warning)).toBeDefined();
      fireEvent.click(within(drawer).getByRole("button", { name: "Add share" }));

      expect(await screen.findByText("Share added")).toBeDefined();
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources").map((request) => request.body)).toEqual([
        {
          kind: "smb",
          name: "NAS",
          host: "nas.local",
          share: "files",
          subfolder: "family",
          username: "alice",
          domain: "",
          protocol: "3.1.1",
          encrypt: false,
          password: "s3cret pass",
        },
      ]);
    });

    it("turns encryption off and the Switch off for SMB 2.1, with the warning", async () => {
      stubApi(handlers({ resources: [], homeRoot: null }));
      await openPage();
      const drawer = await addResource("SMB share");

      fireEvent.change(within(drawer).getByRole("combobox", { name: "Protocol" }), { target: { value: "2.1" } });
      const encrypt = within(drawer).getByRole<HTMLInputElement>("switch", { name: /Encrypt traffic/ });
      expect(encrypt.disabled).toBe(true);
      expect(encrypt.checked).toBe(false);
      expect(within(drawer).getByText("SMB 2.1 can't encrypt traffic.")).toBeDefined();
      expect(within(drawer).getByText(warning)).toBeDefined();

      fireEvent.change(within(drawer).getByRole("combobox", { name: "Protocol" }), { target: { value: "3.0" } });
      expect(within(drawer).getByRole<HTMLInputElement>("switch", { name: /Encrypt traffic/ }).checked).toBe(true);
      expect(within(drawer).queryByText(warning)).toBeNull();
    });

    it("tests the connection and says what it found, in words", async () => {
      let answer = 0;
      const fetchMock = stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources/checks": () =>
              ++answer === 1 ? json(200, { outcome: "connected", folderCount: 5 }) : json(200, { outcome: "failed", reason: "auth" }),
          },
        ),
      );
      await openPage();
      const drawer = await addResource("SMB share");

      fireEvent.click(within(drawer).getByRole("button", { name: "Test connection" }));
      expect(within(drawer).getByText("Enter the server's name or IP address.")).toBeDefined();
      expect(within(drawer).getByText("Enter the password.")).toBeDefined();
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources/checks")).toHaveLength(0);

      type(drawer, "Server", "nas.local");
      type(drawer, "Share", "files");
      type(drawer, "Username", "alice");
      type(drawer, "Password", "secret");
      fireEvent.click(within(drawer).getByRole("button", { name: "Test connection" }));
      expect(await within(drawer).findByText("Signed in, 5 folders found")).toBeDefined();

      type(drawer, "Password", "wrong");
      expect(within(drawer).queryByText("Signed in, 5 folders found")).toBeNull();
      fireEvent.click(within(drawer).getByRole("button", { name: "Test connection" }));
      expect(await within(drawer).findByText("The server refused the user name or password.")).toBeDefined();

      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources/checks").map((request) => request.body)).toEqual([
        {
          kind: "smb",
          host: "nas.local",
          share: "files",
          subfolder: "",
          username: "alice",
          domain: "",
          protocol: "3.1.1",
          encrypt: true,
          password: "secret",
        },
        {
          kind: "smb",
          host: "nas.local",
          share: "files",
          subfolder: "",
          username: "alice",
          domain: "",
          protocol: "3.1.1",
          encrypt: true,
          password: "wrong",
        },
      ]);
    });

    it("says why the server refused to save a share that doesn't mount", async () => {
      stubApi(
        handlers(
          { resources: [], homeRoot: null },
          {
            "POST /api/v1/admin/resources": () =>
              problem(422, problemTypes.shareRefused, "Refused", undefined, { reason: "helper-unavailable" }),
          },
        ),
      );
      await openPage();
      const drawer = await addResource("SMB share");
      type(drawer, "Name", "NAS");
      type(drawer, "Server", "nas.local");
      type(drawer, "Share", "files");
      type(drawer, "Username", "alice");
      type(drawer, "Password", "secret");
      fireEvent.click(within(drawer).getByRole("button", { name: "Add share" }));

      expect(await within(drawer).findByText("This server isn't set up to mount shares yet. Run the install script again.")).toBeDefined();
      expect(screen.getByRole("dialog", { name: "Add SMB share" })).toBeDefined();
    });

    it("edits a share: only the changed fields, and the saved password when it is left empty", async () => {
      const fetchMock = stubApi(
        handlers(
          { resources: [nas], homeRoot: null },
          {
            "POST /api/v1/admin/resources/checks": () => json(200, { outcome: "connected", folderCount: 1 }),
            [`PATCH /api/v1/admin/resources/${nas.id}`]: () => json(200, { ...nas, share: "photos" }),
          },
        ),
      );
      await openPage();
      await screen.findByRole("table", { name: "Resources" });
      fireEvent.click(screen.getByRole("button", { name: "Actions for NAS" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      const drawer = await screen.findByRole("dialog", { name: "Edit resource" });

      expect(within(drawer).getByLabelText<HTMLInputElement>("Server").value).toBe("nas.local");
      expect(within(drawer).getByLabelText<HTMLInputElement>("Password").value).toBe("");
      expect(within(drawer).getByText("Leave empty to keep the saved password.")).toBeDefined();
      type(drawer, "Share", "photos");

      fireEvent.click(within(drawer).getByRole("button", { name: "Test connection" }));
      expect(await within(drawer).findByText("Signed in, 1 folder found")).toBeDefined();
      fireEvent.click(within(drawer).getByRole("button", { name: "Save changes" }));

      expect(await screen.findByText("Resource saved")).toBeDefined();
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources/checks").map((request) => request.body)).toEqual([
        {
          kind: "smb",
          host: "nas.local",
          share: "photos",
          subfolder: "family",
          username: "alice",
          domain: "",
          protocol: "3.1.1",
          encrypt: true,
          resourceId: nas.id,
        },
      ]);
      expect(requestsTo(fetchMock, `PATCH /api/v1/admin/resources/${nas.id}`).map((request) => request.body)).toEqual([
        { kind: "smb", share: "photos" },
      ]);
    });

    it("asks for the password again when the server changes", async () => {
      const fetchMock = stubApi(
        handlers(
          { resources: [nas], homeRoot: null },
          { [`PATCH /api/v1/admin/resources/${nas.id}`]: () => json(200, { ...nas, host: "nas2.local" }) },
        ),
      );
      await openPage();
      await screen.findByRole("table", { name: "Resources" });
      fireEvent.click(screen.getByRole("button", { name: "Actions for NAS" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      const drawer = await screen.findByRole("dialog", { name: "Edit resource" });

      type(drawer, "Server", "nas2.local");
      expect(within(drawer).getByText("Enter it again: the saved password is only sent to the server it was saved for.")).toBeDefined();
      fireEvent.click(within(drawer).getByRole("button", { name: "Test connection" }));
      fireEvent.click(within(drawer).getByRole("button", { name: "Save changes" }));
      expect(within(drawer).getByText("Enter the password.")).toBeDefined();
      expect(requestsTo(fetchMock, "POST /api/v1/admin/resources/checks")).toHaveLength(0);
      expect(requestsTo(fetchMock, `PATCH /api/v1/admin/resources/${nas.id}`)).toHaveLength(0);

      type(drawer, "Password", "secret");
      fireEvent.click(within(drawer).getByRole("button", { name: "Save changes" }));
      expect(await screen.findByText("Resource saved")).toBeDefined();
      expect(requestsTo(fetchMock, `PATCH /api/v1/admin/resources/${nas.id}`).map((request) => request.body)).toEqual([
        { kind: "smb", host: "nas2.local", password: "secret" },
      ]);
    });
  });
});
