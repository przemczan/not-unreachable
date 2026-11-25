import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { resourceIdOf, screenshot, seedHome, seedUserWithSession, sessionCookie, signInAsAdmin } from "./fixtures.ts";

/**
 * Files in both interfaces, against the real server: the admin in a resource
 * (`/admin/files/<id>`), a user in their home (`/files`). Each uploads a file of three tus chunks
 * (UPLOAD_CHUNK_BYTES is 16 MiB) and pauses it after the first, downloads it, resolves a taken
 * name, and deletes a file and a folder. Adds a resource, so it runs after the specs that expect
 * none (playwright.config.ts); the user's home is recorded in it straight away, so the home root
 * invitations.spec.ts sets is left alone.
 */
test.describe.configure({ mode: "serial" });

const MIB = 1024 * 1024;
const suffix = randomBytes(3).toString("hex");
const resourceName = `Files ${suffix}`;
const username = `fred-${suffix}`;

let folder = "";
let resourceId = "";

test.beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "nu-e2e-files-"));
});

test.afterAll(() => {
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
});

/**
 * Holds the second PATCH (the second chunk) of the next upload until `release`, so a test can
 * pause the upload after exactly one chunk; the later PATCHes go through.
 */
async function holdSecondChunk(page: Page): Promise<{ readonly firstChunkSent: Promise<void>; readonly release: () => Promise<void> }> {
  let patches = 0;
  let held: Route | undefined;
  const { promise: firstChunkSent, resolve: chunkSent } = Promise.withResolvers<void>();
  await page.route("**/api/v1/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    patches += 1;
    if (patches !== 2) {
      const response = await route.fetch();
      await route.fulfill({ response });
      if (patches === 1) chunkSent();
      return;
    }
    held = route;
  });
  return {
    firstChunkSent,
    release: async () => {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      // The browser dropped the request when the upload paused.
      await held?.abort().catch(() => undefined);
    },
  };
}

function rowOf(page: Page, table: string, name: string) {
  return page
    .getByRole("table", { name: table })
    .getByRole("row")
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function uploadFiles(page: Page, files: { name: string; buffer: Buffer }[]): Promise<void> {
  await page.getByTestId("upload-input").setInputFiles(files.map((file) => ({ ...file, mimeType: "application/octet-stream" })));
}

async function expectUploaded(page: Page, table: string, name: string): Promise<void> {
  await expect(page.getByText("Upload complete").first()).toBeVisible();
  await expect(rowOf(page, table, name)).toBeVisible();
}

/** Downloads `name` with its row's Download button and checks its suggested name and bytes. */
async function expectDownload(page: Page, table: string, name: string, content: Buffer): Promise<void> {
  const row = rowOf(page, table, name);
  // The name itself is only text: clicking it downloads nothing.
  await expect(row.getByRole("link", { name, exact: true })).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("link", { name: `Download ${name}` }).click()]);
  expect(download.suggestedFilename()).toBe(name);
  const path = await download.path();
  expect(readFileSync(path).equals(content)).toBe(true);
}

/** Creates a folder, then deletes it and the file `file`, confirming each. */
async function createAndDelete(page: Page, table: string, folderName: string, file: string): Promise<void> {
  await page.getByRole("button", { name: "New folder" }).first().click();
  const create = page.getByRole("dialog", { name: "New folder" });
  await create.getByLabel("Folder name").fill(folderName);
  await create.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByText("Folder created")).toBeVisible();
  await expect(create).toBeHidden();
  await expect(rowOf(page, table, folderName)).toBeVisible();

  for (const [name, confirm, toast] of [
    [folderName, "Delete folder", "Folder deleted"],
    [file, "Delete file", "File deleted"],
  ] as const) {
    await rowOf(page, table, name)
      .getByRole("button", { name: `Actions for ${name}` })
      .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
    await dialog.getByRole("button", { name: confirm }).click();
    await expect(page.getByText(toast)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(rowOf(page, table, name)).toHaveCount(0);
  }
}

test("the admin uploads with pause and resume, downloads and deletes in a resource", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/audit-log");
  await page.goto("/admin/resources");
  await page.getByRole("button", { name: "Add resource" }).first().click();
  await page.getByRole("menuitem", { name: "Local folder" }).click();
  const drawer = page.getByRole("dialog", { name: "Add folder" });
  await drawer.getByLabel("Name").fill(resourceName);
  await drawer.getByLabel("Folder path").fill(folder);
  await drawer.getByRole("button", { name: "Check folder" }).click();
  await expect(drawer.getByText("The service can use this folder")).toBeVisible();
  await drawer.getByRole("button", { name: "Add folder" }).click();
  await expect(page.getByText("Folder added")).toBeVisible();
  resourceId = resourceIdOf(resourceName);

  await page.goto(`/admin/files/${resourceId}`);
  await expect(page.getByRole("table", { name: resourceName })).toBeVisible();

  const big = { name: "archive.bin", buffer: randomBytes(40 * MIB) };
  await test.step("uploads a file of three chunks, paused after the first and resumed", async () => {
    const hold = await holdSecondChunk(page);
    await uploadFiles(page, [big]);
    const queue = page.getByRole("region", { name: /^(Uploading 1 file|Uploads)$/ });
    await hold.firstChunkSent;
    await queue.getByRole("button", { name: `Pause upload of ${big.name}` }).click();
    await expect(queue.getByRole("button", { name: `Resume upload of ${big.name}` })).toBeVisible();
    await expect(queue.getByText(/^Paused · /)).toBeVisible();
    await hold.release();

    await queue.getByRole("button", { name: `Resume upload of ${big.name}` }).click();
    await expectUploaded(page, resourceName, big.name);
    expect(readFileSync(join(folder, big.name)).equals(big.buffer)).toBe(true);
  });

  await test.step("downloads the file, whole and a range of it", async () => {
    await screenshot(page, "admin-files-row-buttons");
    await expectDownload(page, resourceName, big.name, big.buffer);
    const ranged = await page.request.get(`/api/v1/admin/resources/${resourceId}/content?path=${big.name}`, {
      headers: { Range: "bytes=0-3" },
    });
    expect(ranged.status()).toBe(206);
    expect((await ranged.body()).equals(big.buffer.subarray(0, 4))).toBe(true);
  });

  await test.step("replaces a file whose name is taken", async () => {
    const first = { name: "notes.txt", buffer: Buffer.from("first version\n") };
    const second = { name: "notes.txt", buffer: Buffer.from("second version\n") };
    await uploadFiles(page, [first]);
    await expectUploaded(page, resourceName, first.name);
    await uploadFiles(page, [second]);
    const conflict = page.getByRole("dialog", { name: "Replace notes.txt?" });
    await conflict.getByRole("button", { name: "Replace file" }).click();
    await expect(conflict).toBeHidden();
    await expect.poll(() => readFileSync(join(folder, "notes.txt"), "utf8")).toBe("second version\n");
    await expect(rowOf(page, resourceName, "notes.txt")).toHaveCount(1);
  });

  await test.step("deletes a folder and a file", async () => {
    await createAndDelete(page, resourceName, "Old reports", "notes.txt");
    expect(existsSync(join(folder, "notes.txt"))).toBe(false);
    expect(existsSync(join(folder, "Old reports"))).toBe(false);
  });

  expect(errors).toEqual([]);
});

test("a user uploads with pause and resume across a reload, downloads and deletes in their home", async ({ page, baseURL }) => {
  expect(resourceId).not.toBe("");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const home = join(folder, "homes", username);
  mkdirSync(home, { recursive: true });
  const user = seedUserWithSession(username);
  seedHome(username, resourceId, `homes/${username}`);
  await page.context().addCookies([sessionCookie(baseURL ?? "", user.sessionToken)]);

  await page.goto("/files");
  await expect(page.getByRole("heading", { level: 1, name: "Files" })).toBeVisible();
  await expect(page.getByText("No files yet")).toBeVisible();

  const big = { name: "holiday.mov", buffer: randomBytes(40 * MIB) };
  await test.step("uploads a file of three chunks, paused after the first, then resumed after a reload", async () => {
    const hold = await holdSecondChunk(page);
    await uploadFiles(page, [big]);
    await hold.firstChunkSent;
    await page.getByRole("button", { name: `Pause upload of ${big.name}` }).click();
    await expect(page.getByRole("button", { name: `Resume upload of ${big.name}` })).toBeVisible();
    await hold.release();

    await page.reload();
    await expect(page.getByText(`Choose ${big.name} again to resume`)).toBeVisible();
    await uploadFiles(page, [big]);
    await expectUploaded(page, "Files", big.name);
    expect(readFileSync(join(home, big.name)).equals(big.buffer)).toBe(true);
  });

  await test.step("downloads the file, whole and a range of it", async () => {
    await expectDownload(page, "Files", big.name, big.buffer);
    const ranged = await page.request.get(`/api/v1/home/content?path=${big.name}`, { headers: { Range: "bytes=0-3" } });
    expect(ranged.status()).toBe(206);
    expect((await ranged.body()).equals(big.buffer.subarray(0, 4))).toBe(true);
  });

  await test.step("keeps both files when a name is taken", async () => {
    const note = { name: "todo.txt", buffer: Buffer.from("buy milk\n") };
    await uploadFiles(page, [note]);
    await expectUploaded(page, "Files", note.name);
    await uploadFiles(page, [{ ...note, buffer: Buffer.from("buy bread\n") }]);
    const conflict = page.getByRole("dialog", { name: "Replace todo.txt?" });
    await conflict.getByRole("button", { name: "Keep both" }).click();
    await expect(conflict).toBeHidden();
    await expect(
      page
        .getByRole("table", { name: "Files" })
        .getByRole("row")
        .filter({ has: page.getByText(/^todo.*\.txt$/) }),
    ).toHaveCount(2);
    expect(readFileSync(join(home, "todo.txt"), "utf8")).toBe("buy milk\n");
  });

  await test.step("deletes a folder and a file", async () => {
    await createAndDelete(page, "Files", "Drafts", big.name);
    expect(existsSync(join(home, big.name))).toBe(false);
  });

  expect(errors).toEqual([]);
});
