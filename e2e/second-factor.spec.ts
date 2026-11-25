import { expect, test } from "@playwright/test";
import {
  admin,
  freshAdminTotpCode,
  recoveryCodesFileName,
  replaceAdminRecoveryCodes,
  screenshot,
  seedAdminSession,
  sessionCookie,
  takeAdminRecoveryCode,
} from "./fixtures.ts";

/**
 * The admin's second factor, after smoke.spec.ts added the authenticator app at the first sign-in.
 * In order: the codes signed in with here are the ones the later tests no longer have.
 */
test.describe.configure({ mode: "serial" });

test("the admin signs in with an authenticator code, after a wrong one", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Username or email").fill(admin.username);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL("/sign-in/second-factor");
  await expect(page.getByRole("heading", { level: 1, name: "Two-step sign-in" })).toBeVisible();
  const firstBox = page.getByRole("group", { name: "Authenticator code" }).getByRole("textbox", { name: "Digit 1 of 6" });
  await expect(firstBox).toBeFocused();
  // The other pages wait for the step.
  await page.goto("/admin/resources");
  await expect(page).toHaveURL(`/sign-in/second-factor?next=${encodeURIComponent("/admin/resources")}`);

  await firstBox.fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("The code is not right. Check the code in your app and try again.")).toBeVisible();
  await screenshot(page, "second-factor-verify");

  await firstBox.fill(await freshAdminTotpCode());
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL("/admin/resources");
  await expect(page.getByRole("heading", { level: 1, name: "Resources" })).toBeVisible();
});

test("the admin signs in with a recovery code instead", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Username or email").fill(admin.username);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page.getByLabel("Recovery code").fill(await takeAdminRecoveryCode());
  await screenshot(page, "second-factor-recovery-code");
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(page).toHaveURL("/admin/audit-log");
  await expect(page.getByRole("listitem").filter({ hasText: "Recovery code used" }).first()).toBeVisible();
});

test("Settings shows the app and the codes left; regenerating them confirms the sign-in with a code", async ({ page, baseURL }) => {
  // A session with no recent sign-in, so regenerating asks "Confirm it's you".
  await page.context().addCookies([sessionCookie(baseURL ?? "", seedAdminSession())]);
  await page.goto("/settings/profile");
  await page.getByRole("navigation", { name: "Account settings sections" }).getByRole("link", { name: "Two-step sign-in" }).click();

  await expect(page).toHaveURL("/settings/two-step-sign-in");
  const apps = page.getByRole("table", { name: "Your authenticator apps" });
  await expect(apps.getByRole("row").filter({ hasText: "Authenticator app" })).toHaveCount(1);
  await expect(apps.getByRole("button", { name: "Remove" })).toBeDisabled();
  await expect(page.getByText("Your last authenticator app can't be removed. Add another one first.")).toBeVisible();
  await expect(page.getByText("9 / 10 left")).toBeVisible();
  await screenshot(page, "settings-two-step-sign-in");

  await page.getByRole("button", { name: "Regenerate recovery codes" }).click();
  await page.getByRole("dialog", { name: "Regenerate recovery codes?" }).getByRole("button", { name: "Regenerate codes" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("radio", { name: "Authenticator code" }).click();
  const firstBox = confirm.getByRole("group", { name: "Authenticator code" }).getByRole("textbox", { name: "Digit 1 of 6" });
  await expect(firstBox).toBeFocused();
  await screenshot(page, "recent-sign-in-code");
  await firstBox.fill(await freshAdminTotpCode());
  await confirm.getByRole("button", { name: "Confirm" }).click();

  const shown = page.getByRole("dialog", { name: "Save your new recovery codes" });
  await expect(shown).toBeVisible();
  const recoveryCodes = ((await shown.getByRole("group", { name: "Recovery codes" }).locator("code").textContent()) ?? "").split("\n");
  expect(recoveryCodes).toHaveLength(10);
  await replaceAdminRecoveryCodes(recoveryCodes);
  const download = page.waitForEvent("download");
  await shown.getByRole("button", { name: "Download codes" }).click();
  expect((await download).suggestedFilename()).toBe(recoveryCodesFileName);
  await shown.getByLabel("I saved my recovery codes").check();
  await screenshot(page, "settings-recovery-codes");
  await shown.getByRole("button", { name: "Done" }).click();

  await expect(page.getByText("Recovery codes regenerated")).toBeVisible();
  await expect(page.getByText("10 / 10 left")).toBeVisible();
});
