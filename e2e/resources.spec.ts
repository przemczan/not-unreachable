import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { screenshot, signInAsAdmin } from "./fixtures.ts";

/**
 * The admin adds a local folder and makes it the home root. The server runs on this machine as
 * this user (playwright.config.ts), so a fresh temp folder is one it can write, outside its DATA_DIR.
 */
let folder = "";

test.beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "nu-e2e-resource-"));
  // Folders for the Subfolder's suggestions, and a file it never suggests.
  mkdirSync(join(folder, "people", "staff"), { recursive: true });
  writeFileSync(join(folder, "people", "staff-list.txt"), "list");
});

test.afterAll(() => {
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
});

test("the admin adds a local folder and sets it as the home root", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/dashboard");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Resources" }).click();
  await expect(page).toHaveURL("/admin/resources");
  await expect(page.getByRole("heading", { level: 1, name: "Resources" })).toBeVisible();
  await expect(page.getByText("No resources yet")).toBeVisible();
  await expect(page.getByText("Users can't be invited until a home root is chosen.")).toBeVisible();

  await page.getByRole("button", { name: "Add resource" }).first().click();
  await page.getByRole("menuitem", { name: "Local folder" }).click();
  const drawer = page.getByRole("dialog", { name: "Add folder" });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("Name", { exact: true }).fill("Shared files");
  await drawer.getByLabel("Folder path").fill(folder);
  await drawer.getByRole("button", { name: "Check folder" }).click();
  await expect(drawer.getByText("The service can use this folder")).toBeVisible();
  await drawer.getByRole("button", { name: "Add folder" }).click();

  await expect(page.getByText("Folder added")).toBeVisible();
  await expect(drawer).toBeHidden();
  const row = page.getByRole("table", { name: "Resources" }).getByRole("row").filter({ hasText: "Shared files" });
  await expect(row.getByText(folder)).toBeVisible();
  await expect(row.getByText("Available")).toBeVisible();

  const homeRoot = page.getByRole("radiogroup", { name: "Home root" });
  await homeRoot.getByRole("radio", { name: "Shared files" }).check();
  const subfolder = page.getByRole("combobox", { name: "Subfolder" });
  await subfolder.fill("PE");
  await page.getByRole("option", { name: "people" }).click();
  await expect(subfolder).toHaveValue("people/");
  await expect(page.getByRole("option")).toHaveText(["staff"]);
  await screenshot(page, "home-root-subfolder-suggestions");
  await subfolder.press("ArrowDown");
  await subfolder.press("Enter");
  await expect(subfolder).toHaveValue("people/staff/");
  await subfolder.fill("homes");
  await expect(page.getByRole("listbox")).toBeHidden();
  await page.getByRole("button", { name: "Save home root" }).click();
  const confirm = page.getByRole("dialog", { name: "Set the home root?" });
  await expect(confirm.getByText("Existing homes stay where they are.", { exact: false })).toBeVisible();
  await confirm.getByRole("button", { name: "Save home root" }).click();

  await expect(page.getByText("Home root saved")).toBeVisible();
  await expect(confirm).toBeHidden();
  await expect(row.getByText("Home root", { exact: true })).toBeVisible();
  await expect(page.getByText("No home root yet")).toHaveCount(0);
  await expect(homeRoot.getByRole("radio", { name: "Shared files" })).toBeChecked();
  await expect(page.getByLabel("Subfolder")).toHaveValue("homes");
  expect(existsSync(join(folder, "homes"))).toBe(true);

  // The home root's resource can't be removed.
  await row.getByRole("button", { name: "Actions for Shared files" }).click();
  await expect(page.getByRole("menuitem", { name: "Holds the home root: can't be removed" })).toBeDisabled();
  await page.keyboard.press("Escape");

  expect(errors).toEqual([]);
});

/**
 * The admin fills in an SMB share and tests the connection. The e2e server has no mount helper
 * (playwright.config.ts), so the test can only fail: the Alert says why, in words.
 */
test("the admin fills in an SMB share, sees the unencrypted warning and tests the connection", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signInAsAdmin(page);
  await page.goto("/admin/resources");
  await expect(page.getByRole("heading", { level: 1, name: "Resources" })).toBeVisible();

  await page.getByRole("button", { name: "Add resource" }).first().click();
  await page.getByRole("menuitem", { name: "SMB share" }).click();
  const drawer = page.getByRole("dialog", { name: "Add SMB share" });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("Name", { exact: true }).fill("NAS");
  await drawer.getByLabel("Server", { exact: true }).fill("127.0.0.1");
  await drawer.getByLabel("Share", { exact: true }).fill("files");
  await drawer.getByLabel("Username", { exact: true }).fill("alice");
  await drawer.getByLabel("Password", { exact: true }).fill("not-a-real-password");
  await expect(drawer.getByLabel("Protocol")).toHaveValue("3.1.1");

  const warning = drawer.getByText("Traffic to this share is not encrypted");
  await expect(warning).toHaveCount(0);
  await drawer.getByRole("switch", { name: /Encrypt traffic/ }).uncheck();
  await expect(warning).toBeVisible();

  await drawer.getByRole("button", { name: "Test connection" }).click();
  await expect(drawer.getByRole("alert").filter({ hasText: "This share can't be used" })).toBeVisible();

  expect(errors).toEqual([]);
});
