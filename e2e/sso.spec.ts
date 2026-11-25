import { expect, test } from "@playwright/test";
import { admin, freshAdminTotpCode, screenshot, signInAsAdmin } from "./fixtures.ts";
import { MOCK_OIDC_CLIENT_ID, MOCK_OIDC_CLIENT_SECRET, MOCK_OIDC_ISSUER, mockOidcIdentity } from "./mock-oidc.ts";

/**
 * Single sign-on against the mock OIDC provider (e2e/mock-oidc.ts), which approves every
 * authorization request at once. An identity signs in only once it is linked, so the admin first
 * adds the provider and links it, then signs out and signs in with it, still passing the second step.
 */
const providerName = "Example Identity";

test("the admin adds an OIDC provider, links it and signs in with it, then passes the second step", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // A fresh password sign-in, so the writes below don't ask for a recent one.
  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/audit-log");

  await page.goto("/admin/settings/sign-in-providers");
  await expect(page.getByText("No sign-in providers yet")).toBeVisible();
  await page.getByRole("button", { name: "Add provider" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Add provider" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("radio", { name: "OpenID Connect" }).check();
  // The redirect URI to register at the provider is there before the provider is added.
  await expect(drawer.getByText("How to set this up")).toBeVisible();
  const redirectUri = drawer.getByRole("group", { name: "Redirect URI" }).locator("code");
  await expect(redirectUri).toHaveText(/^http:\/\/localhost:8481\/api\/v1\/sso\/[0-9a-f-]{36}\/callback$/);
  const registered = await redirectUri.textContent();
  await screenshot(page, "admin-sign-in-provider-drawer");
  await drawer.getByLabel("Name").fill(providerName);
  await drawer.getByLabel("Issuer").fill(MOCK_OIDC_ISSUER);
  await drawer.getByLabel("Client ID").fill(MOCK_OIDC_CLIENT_ID);
  await drawer.getByLabel("Client secret").fill(MOCK_OIDC_CLIENT_SECRET);
  // Saving checks the issuer by discovery, from the server, over TLS.
  await drawer.getByRole("button", { name: "Add provider" }).click();

  await expect(page.getByText("Provider added")).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(page.getByText(providerName, { exact: true })).toBeVisible();
  // The provider added has the redirect URI shown before: nothing registered has to change.
  await page.getByRole("button", { name: `Actions for ${providerName}` }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit provider" });
  await expect(edit.getByRole("group", { name: "Redirect URI" }).locator("code")).toHaveText(registered ?? "");
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeHidden();
  await screenshot(page, "admin-sign-in-providers");

  // Linking goes through the provider and comes back to Settings.
  await page.goto("/settings/linked-sign-ins");
  await expect(page.getByText("No linked sign-ins")).toBeVisible();
  await page.getByRole("button", { name: `Link ${providerName}` }).click();
  await expect(page).toHaveURL(/\/settings\/linked-sign-ins\?linked=[0-9a-f-]{36}$/);
  await expect(page.getByText(`${providerName} linked. You can sign in with it now.`)).toBeVisible();
  const linked = page.getByRole("table", { name: "Your linked sign-ins" }).getByRole("row").filter({ hasText: providerName });
  await expect(linked.getByText(mockOidcIdentity.email)).toBeVisible();
  await expect(linked.getByText("Never")).toBeVisible();
  await screenshot(page, "settings-linked-sign-ins");

  await page.getByRole("button", { name: `Account: ${admin.displayName}` }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/sign-in");
  await expect(page.getByRole("button", { name: `Continue with ${providerName}` })).toBeVisible();
  await screenshot(page, "sign-in-with-providers");

  // Signing in by SSO still needs the admin's second factor.
  await page.getByRole("button", { name: `Continue with ${providerName}` }).click();
  await expect(page).toHaveURL("/sign-in/second-factor");
  await expect(page.getByRole("heading", { level: 1, name: "Two-step sign-in" })).toBeVisible();
  await page
    .getByRole("group", { name: "Authenticator code" })
    .getByRole("textbox", { name: "Digit 1 of 6" })
    .fill(await freshAdminTotpCode());
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(page).toHaveURL(/^http:\/\/localhost:8481\/admin(\/|$)/);
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();

  await page.goto("/settings/linked-sign-ins");
  await expect(linked.getByText("Never")).toHaveCount(0);

  expect(errors).toEqual([]);
});
