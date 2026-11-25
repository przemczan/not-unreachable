import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { resourceIdOf, screenshot, seedUserWithSession, sessionCookie, signInAsAdmin } from "./fixtures.ts";

/**
 * Share links against the real server (threat model, T8): the admin makes a password-protected
 * link to a file in a resource, someone else opens it in a browser of their own, types the password
 * and downloads the file; a folder link is browsed; a link for selected users opens only for them, and
 * shows in their Shared with me; an unknown link says it is not valid. Adds a
 * resource, so it runs after the specs that expect none (playwright.config.ts).
 */
test.describe.configure({ mode: "serial" });

const suffix = randomBytes(3).toString("hex");
const resourceName = `Shares ${suffix}`;
const linkPassword = "open sesame 2026";
const reportContent = `The quarterly report, ${randomBytes(16).toString("hex")}.\n`;

let folder = "";
let resourceId = "";

test.beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "nu-e2e-shares-"));
  writeFileSync(join(folder, "report.txt"), reportContent);
  mkdirSync(join(folder, "Album", "2026"), { recursive: true });
  writeFileSync(join(folder, "Album", "cover.txt"), "cover\n");
  writeFileSync(join(folder, "Album", "2026", "beach.txt"), "beach\n");
});

test.afterAll(() => {
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
});

function rowOf(page: Page, table: string, name: string) {
  return page
    .getByRole("table", { name: table })
    .getByRole("row")
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function addResource(page: Page): Promise<void> {
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
}

async function openShareDialog(page: Page, name: string) {
  await page.goto(`/admin/files/${resourceId}`);
  await rowOf(page, resourceName, name)
    .getByRole("button", { name: `Share ${name}` })
    .click();
  const dialog = page.getByRole("dialog", { name: `Share ${name}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Creates the link from the open dialog; answers its URL, from the CopyField. */
async function createLink(page: Page, dialog: ReturnType<Page["getByRole"]>): Promise<string> {
  await dialog.getByRole("button", { name: "Create share link" }).click();
  const created = page.getByRole("dialog", { name: "Share link created" });
  const link = (await created.getByRole("group", { name: "Link" }).locator("code").textContent()) ?? "";
  expect(link).toMatch(/\/s\/[\w-]{43}$/);
  await created.getByRole("button", { name: "Done" }).click();
  await expect(created).toBeHidden();
  return link;
}

test("the admin shares a file with a password, and someone else unlocks and downloads it", async ({ page, browser }) => {
  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/audit-log");
  await addResource(page);

  const dialog = await openShareDialog(page, "report.txt");
  await expect(dialog.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("switch", { name: "Require a password" }).check();
  await dialog.getByLabel("Password", { exact: true }).fill(linkPassword);
  await screenshot(page, "share-link-create-dialog");
  const link = await createLink(page, dialog);

  await test.step("lists the link on the Share links screen", async () => {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Share links" }).click();
    await expect(page).toHaveURL("/admin/share-links");
    const row = rowOf(page, "Share links", "report.txt");
    await expect(row.getByText("Password", { exact: true })).toBeVisible();
    await expect(row.getByText(/^Expires /)).toBeVisible();
    await screenshot(page, "share-links-admin");
  });

  await test.step("opens the link in a fresh browser, types the password and downloads the file", async () => {
    const context = await browser.newContext();
    try {
      const visitor = await context.newPage();
      await visitor.goto(link);
      await expect(visitor.getByText("This link needs a password.")).toBeVisible();
      await expect(visitor.getByText("report.txt")).toBeVisible();
      await expect(visitor.getByRole("link", { name: "Download" })).toHaveCount(0);
      // Nothing says which resource or path the link points into (T8).
      await expect(visitor.getByText(resourceName)).toHaveCount(0);
      await screenshot(visitor, "share-public-password");

      await visitor.getByLabel("Password", { exact: true }).fill("not the password");
      await visitor.getByRole("button", { name: "Unlock" }).click();
      await expect(visitor.getByText("The password is wrong.")).toBeVisible();

      await visitor.getByLabel("Password", { exact: true }).fill(linkPassword);
      await visitor.getByRole("button", { name: "Unlock" }).click();
      const download = visitor.getByRole("link", { name: "Download" });
      await expect(download).toBeVisible();
      const [file] = await Promise.all([visitor.waitForEvent("download"), download.click()]);
      expect(file.suggestedFilename()).toBe("report.txt");
      expect(readFileSync(await file.path(), "utf8")).toBe(reportContent);
    } finally {
      await context.close();
    }
  });

  await test.step("counts the download", async () => {
    await page.reload();
    await expect(rowOf(page, "Share links", "report.txt").getByRole("cell").nth(4)).toHaveText("1");
  });
});

test("someone browses a folder link and downloads a file inside it", async ({ page, browser }) => {
  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/audit-log");
  const dialog = await openShareDialog(page, "Album");
  const link = await createLink(page, dialog);

  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    await visitor.goto(link);
    const table = visitor.getByRole("table", { name: "Album" });
    await expect(table.getByRole("link", { name: "2026", exact: true })).toBeVisible();
    // A file's name is only text; its Download button downloads it.
    await expect(table.getByText("cover.txt", { exact: true })).toBeVisible();
    await expect(table.getByRole("link", { name: "cover.txt", exact: true })).toHaveCount(0);
    await expect(table.getByRole("link", { name: "Download cover.txt" })).toBeVisible();
    await screenshot(visitor, "share-public-folder");

    await table.getByRole("link", { name: "2026", exact: true }).click();
    const inner = visitor.getByRole("table", { name: "Album / 2026" });
    await expect(visitor.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    const [file] = await Promise.all([visitor.waitForEvent("download"), inner.getByRole("link", { name: "Download beach.txt" }).click()]);
    expect(file.suggestedFilename()).toBe("beach.txt");
    expect(readFileSync(await file.path(), "utf8")).toBe("beach\n");
  } finally {
    await context.close();
  }
});

test("a link for selected users opens only for them: others are asked to sign in or refused", async ({ page, browser, baseURL }) => {
  const picked = seedUserWithSession(`pia-${suffix}`);
  const other = seedUserWithSession(`otto-${suffix}`);
  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/audit-log");

  const dialog = await openShareDialog(page, "report.txt");
  await dialog.getByRole("radio", { name: "Selected users" }).check();
  await dialog.getByLabel("Filter users").fill(picked.username);
  // The fixture's users share a display name; the filter leaves only the picked one.
  await dialog.getByRole("checkbox", { name: picked.displayName }).check();
  await screenshot(page, "share-link-create-selected-users");
  const link = await createLink(page, dialog);

  await page.goto("/admin/share-links");
  await expect(rowOf(page, "Share links", "report.txt").getByText("1 user", { exact: true }).first()).toBeVisible();
  await screenshot(page, "share-links-admin-access");

  const visit = async (sessionToken: string | null) => {
    const context = await browser.newContext();
    if (sessionToken !== null) await context.addCookies([sessionCookie(baseURL ?? "", sessionToken)]);
    const visitor = await context.newPage();
    await visitor.goto(link);
    return { context, visitor };
  };

  await test.step("a signed-out visitor is asked to sign in, and sees nothing of the item", async () => {
    const { context, visitor } = await visit(null);
    try {
      await expect(visitor.getByText("Sign in to open this link")).toBeVisible();
      await expect(visitor.getByText("report.txt")).toHaveCount(0);
      await expect(visitor.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", /^\/sign-in\?next=%2Fs%2F/);
      await screenshot(visitor, "share-public-sign-in-required");
    } finally {
      await context.close();
    }
  });

  await test.step("a user the link isn't shared with is refused", async () => {
    const { context, visitor } = await visit(other.sessionToken);
    try {
      await expect(visitor.getByText("This link was shared with other people")).toBeVisible();
      await expect(visitor.getByText(other.username)).toBeVisible();
      await expect(visitor.getByText("report.txt")).toHaveCount(0);
      await screenshot(visitor, "share-public-not-allowed");
    } finally {
      await context.close();
    }
  });

  await test.step("the picked user downloads the file", async () => {
    const { context, visitor } = await visit(picked.sessionToken);
    try {
      const download = visitor.getByRole("link", { name: "Download" });
      await expect(download).toBeVisible();
      const [file] = await Promise.all([visitor.waitForEvent("download"), download.click()]);
      expect(readFileSync(await file.path(), "utf8")).toBe(reportContent);
    } finally {
      await context.close();
    }
  });

  await test.step("the picked user finds the link in Shared with me and opens it", async () => {
    const context = await browser.newContext();
    await context.addCookies([sessionCookie(baseURL ?? "", picked.sessionToken)]);
    try {
      const user = await context.newPage();
      await user.goto("/shared");
      await expect(user.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Shared with me" })).toBeVisible();
      const row = rowOf(user, "Shared with me", "report.txt");
      await expect(row.getByText("File", { exact: true })).toBeVisible();
      await expect(row.getByText(/^Expires /)).toBeVisible();
      // Nothing says which resource or path the link points into (T8).
      await expect(user.getByText(resourceName)).toHaveCount(0);
      await screenshot(user, "shared-with-me");

      await row.getByRole("link", { name: "report.txt" }).click();
      await expect(user).toHaveURL(link);
      await expect(user.getByRole("link", { name: "Download" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  await test.step("a user the link isn't shared with doesn't see it in Shared with me", async () => {
    const context = await browser.newContext();
    await context.addCookies([sessionCookie(baseURL ?? "", other.sessionToken)]);
    try {
      const user = await context.newPage();
      await user.goto("/shared");
      await expect(user.getByRole("heading", { name: "Shared with me" })).toBeVisible();
      await expect(user.getByRole("table", { name: "Shared with me" })).toBeVisible();
      await expect(user.getByRole("link", { name: "report.txt" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test("an unknown link says it is not valid", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    const response = await visitor.goto(`/s/${randomBytes(32).toString("base64url")}`);
    expect(response?.headers()["x-robots-tag"]).toContain("noindex");
    await expect(visitor.getByText("This link is not valid")).toBeVisible();
    await expect(visitor.getByRole("link", { name: "Download" })).toHaveCount(0);
    await screenshot(visitor, "share-invalid-link");
  } finally {
    await context.close();
  }
});
