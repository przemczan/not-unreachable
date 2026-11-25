import { expect, test, type Page } from "@playwright/test";
import { admin, expectNoViolations, screenshot, seedAdminSession, sessionCookie, watchViolations } from "./fixtures.ts";

/**
 * The admin's passkey, held by Chromium's virtual authenticator (CDP WebAuthn domain): added in
 * Settings, then passed as the second factor after the password, then signing in on its own. The
 * authenticator lives in the page, so one test walks the whole way, and removes the passkey at the
 * end so the admin is left with the authenticator app alone, as the other specs expect.
 */
test.describe.configure({ mode: "serial" });

const passkeyName = "Virtual key";

/** A platform authenticator with user verification, which answers every prompt at once. */
async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function openTwoStepSettings(page: Page): Promise<void> {
  await page.goto("/settings/two-step-sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Account settings" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Your passkeys" })).toBeVisible();
}

/** Confirms "Confirm it's you" with the password, when the action asked for it. */
async function confirmWithPasswordIfAsked(page: Page, done: ReturnType<Page["getByText"]>): Promise<void> {
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(confirm.or(done)).toBeVisible();
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Password", { exact: true }).fill(admin.password);
    await confirm.getByRole("button", { name: "Confirm" }).click();
  }
  await expect(done).toBeVisible();
}

test("the admin adds a passkey, passes the second step with it, then signs in with it alone", async ({ page, baseURL }) => {
  const problems = await watchViolations(page);
  await addVirtualAuthenticator(page);

  await test.step("adds a passkey in Settings, confirming the recent sign-in", async () => {
    await page.context().addCookies([sessionCookie(baseURL ?? "", seedAdminSession())]);
    await openTwoStepSettings(page);
    await expect(page.getByText("No passkeys")).toBeVisible();

    await page.getByRole("button", { name: "Add passkey" }).click();
    const dialog = page.getByRole("dialog", { name: "Add passkey" });
    await dialog.getByLabel("Passkey name").fill(passkeyName);
    await dialog.getByRole("button", { name: "Add passkey" }).click();

    const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(confirm).toBeVisible();
    await confirm.getByLabel("Password", { exact: true }).fill(admin.password);
    await confirm.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByText("Passkey added")).toBeVisible();
    await expect(dialog).toBeHidden();
    const row = page.getByRole("table", { name: "Your passkeys" }).getByRole("row").filter({ hasText: passkeyName });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("Never")).toBeVisible();
    // With a passkey too, the authenticator app is no longer the last factor.
    await expect(page.getByRole("table", { name: "Your authenticator apps" }).getByRole("button", { name: "Remove" })).toBeEnabled();
    await screenshot(page, "settings-two-step-sign-in-passkeys");
  });

  await test.step("passes the second step with the passkey after the password", async () => {
    await page.context().clearCookies();
    await page.goto(`/sign-in?next=${encodeURIComponent("/admin/resources")}`);
    await page.getByLabel("Username or email").fill(admin.username);
    await page.getByLabel("Password", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Two-step sign-in" })).toBeVisible();
    await page.getByRole("button", { name: "Use a passkey" }).click();
    await expect(page.getByText("Use one of your passkeys to finish signing in.")).toBeVisible();
    await screenshot(page, "second-factor-passkey");
    await page.getByRole("button", { name: "Use passkey" }).click();

    await expect(page).toHaveURL("/admin/resources");
    await expect(page.getByRole("heading", { level: 1, name: "Resources" })).toBeVisible();
  });

  await test.step("signs in with the passkey alone, landing in /admin", async () => {
    await page.context().clearCookies();
    await page.goto("/sign-in");
    const button = page.getByRole("button", { name: "Sign in with a passkey" });
    await expect(button).toBeVisible();
    await screenshot(page, "sign-in-passkey");
    await button.click();

    await expect(page).toHaveURL(/\/admin(\/|$)/);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await page.goto("/admin/audit-log");
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: /passkey/i })
        .first(),
    ).toBeVisible();
  });

  await test.step("renames the passkey, then removes it", async () => {
    await openTwoStepSettings(page);
    const table = page.getByRole("table", { name: "Your passkeys" });
    const row = table.getByRole("row").filter({ hasText: passkeyName });
    // It has signed in: no longer "Never" used.
    await expect(row.getByText("Never")).toHaveCount(0);

    await row.getByRole("button", { name: `Actions for the passkey ${passkeyName}` }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const rename = page.getByRole("dialog", { name: "Rename passkey" });
    await rename.getByLabel("Passkey name").fill("Old virtual key");
    await rename.getByRole("button", { name: "Rename passkey" }).click();
    await expect(page.getByText("Passkey renamed")).toBeVisible();
    const renamed = table.getByRole("row").filter({ hasText: "Old virtual key" });
    await expect(renamed).toHaveCount(1);

    await renamed.getByRole("button", { name: "Actions for the passkey Old virtual key" }).click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await page.getByRole("dialog", { name: "Remove this passkey?" }).getByRole("button", { name: "Remove passkey" }).click();
    await confirmWithPasswordIfAsked(page, page.getByText("Passkey removed"));
    await expect(page.getByText("No passkeys")).toBeVisible();
    await expect(page.getByRole("table", { name: "Your authenticator apps" }).getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  await expectNoViolations(page, problems);
});
