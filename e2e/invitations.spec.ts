import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ensureMockOidcProvider, mockOidcProviderName, screenshot, setHomeRoot, signInAsAdmin } from "./fixtures.ts";
import { mockOidcSubjectCookie } from "./mock-oidc.ts";

/**
 * Invitations and re-link links, against the mock OIDC provider (e2e/mock-oidc.ts), which signs in
 * as the person a browser context's cookie names. The admin makes sure of the mock's provider (sso.spec.ts
 * adds it; one issuer has one provider), adds a home root, invites
 * someone who creates their account with identity A, then sends them a re-link link that swaps A
 * for identity B. Runs after the other specs (playwright.config.ts), which expect no providers or
 * resources when they start.
 */
test.describe.configure({ mode: "serial" });

const providerName = mockOidcProviderName;
const suffix = randomBytes(3).toString("hex");
const invitee = { username: `iris-${suffix}`, displayName: "Iris Invited" } as const;
const identityA = `invitee-a-${suffix}`;
const identityB = `invitee-b-${suffix}`;

let folder = "";

test.beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "nu-e2e-invitations-"));
});

test.afterAll(() => {
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
});

/** A fresh, signed-out browser context whose mock provider signs in as `sub`. */
async function personAs(browser: Browser, sub: string): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([mockOidcSubjectCookie(sub)]);
  return context.newPage();
}

async function expectSignedInToFiles(page: Page): Promise<void> {
  await expect(page).toHaveURL("/files");
  await expect(page.getByRole("heading", { level: 1, name: "Files" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Account: ${invitee.displayName}` })).toBeVisible();
}

test("the admin invites someone, who creates their account with a provider and lands in Files", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/audit-log");
  await ensureMockOidcProvider(page);
  await setHomeRoot(page, "Invitation homes", folder);

  await page.goto("/admin/users/invitations");
  await page.getByRole("button", { name: "Invite user" }).first().click();
  const invite = page.getByRole("dialog", { name: "Invite user" });
  await expect(invite).toBeVisible();
  await invite.getByRole("button", { name: "Create invitation" }).click();
  const created = page.getByRole("dialog", { name: "Invitation created" });
  await expect(created).toBeVisible();
  const link = await created.getByRole("group", { name: "Invitation link" }).locator("code").innerText();
  expect(link).toMatch(/^http:\/\/localhost:8481\/invitation\/[\w-]+$/);
  await screenshot(page, "admin-invitation-created");
  await created.getByRole("button", { name: "Done" }).click();
  await expect(created).toBeHidden();
  const invitations = page.getByRole("table", { name: "Invitations" });
  await expect(invitations.getByRole("row").filter({ hasText: "No email" }).getByText("Pending")).toBeVisible();

  const person = await personAs(browser, identityA);
  const personErrors: string[] = [];
  person.on("pageerror", (error) => personErrors.push(error.message));
  await person.goto(link);
  await expect(person.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
  await person.getByLabel("Username").fill(invitee.username);
  await person.getByLabel("Display name").fill(invitee.displayName);
  await screenshot(person, "invitation-accept");
  await person.getByRole("button", { name: `Continue with ${providerName}` }).click();
  await expectSignedInToFiles(person);
  await person.context().close();

  // The link works once.
  const again = await personAs(browser, identityA);
  await again.goto(link);
  await expect(again.getByRole("heading", { level: 1, name: "This link is not valid" })).toBeVisible();
  await again.context().close();

  await page.goto("/admin/users");
  const row = page.getByRole("table", { name: "Users" }).getByRole("row").filter({ hasText: invitee.username });
  await expect(row.getByText(invitee.displayName)).toBeVisible();
  await expect(row.getByText("Active")).toBeVisible();
  await expect(row.getByText(providerName)).toBeVisible();
  await screenshot(page, "admin-users");

  expect(errors).toEqual([]);
  expect(personErrors).toEqual([]);
});

test("a re-link link swaps the user's sign-in for a new identity and signs them out elsewhere", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // The user is signed in with identity A somewhere.
  const before = await personAs(browser, identityA);
  await before.goto("/sign-in");
  await before.getByRole("button", { name: `Continue with ${providerName}` }).click();
  await expectSignedInToFiles(before);

  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/audit-log");
  await page.goto("/admin/users");
  const row = page.getByRole("table", { name: "Users" }).getByRole("row").filter({ hasText: invitee.username });
  await row.getByRole("button", { name: `Actions for ${invitee.displayName}` }).click();
  await page.getByRole("menuitem", { name: "Send re-link link" }).click();
  const confirm = page.getByRole("dialog", { name: `Send a re-link link to ${invitee.displayName}?` });
  await confirm.getByRole("button", { name: "Create link" }).click();
  const created = page.getByRole("dialog", { name: "Re-link link created" });
  await expect(created).toBeVisible();
  const link = await created.getByRole("group", { name: "Re-link link" }).locator("code").innerText();
  expect(link).toMatch(/^http:\/\/localhost:8481\/relink\/[\w-]+$/);
  await created.getByRole("button", { name: "Done" }).click();
  await expect(created).toBeHidden();

  const person = await personAs(browser, identityB);
  await person.goto(link);
  await expect(person.getByRole("heading", { level: 1, name: "Link a new sign-in" })).toBeVisible();
  await screenshot(person, "relink");
  await person.getByRole("button", { name: `Continue with ${providerName}` }).click();
  await expectSignedInToFiles(person);
  await person.context().close();

  // Signed out everywhere else.
  await before.reload();
  await expect(before).toHaveURL(/\/sign-in(\?|$)/);
  await before.context().close();

  // Identity A no longer signs in; identity B does.
  const withA = await personAs(browser, identityA);
  await withA.goto("/sign-in");
  await withA.getByRole("button", { name: `Continue with ${providerName}` }).click();
  await expect(withA).toHaveURL(/\/sign-in\?error=/);
  await expect(withA.getByText("We couldn't sign you in with that account.", { exact: false })).toBeVisible();
  await withA.context().close();

  const withB = await personAs(browser, identityB);
  await withB.goto("/sign-in");
  await withB.getByRole("button", { name: `Continue with ${providerName}` }).click();
  await expectSignedInToFiles(withB);
  await withB.context().close();

  expect(errors).toEqual([]);
});

test("an invitation that requires a verified email accepts only the account with that email", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const invited = `verified-${suffix}`;
  const stranger = `stranger-${suffix}`;

  await signInAsAdmin(page);
  await expect(page).toHaveURL("/admin/audit-log");
  await page.goto("/admin/users/invitations");
  await page.getByRole("button", { name: "Invite user" }).first().click();
  const invite = page.getByRole("dialog", { name: "Invite user" });
  await invite.getByRole("textbox", { name: "Email" }).fill(`${invited}@example.com`);
  await invite.getByLabel("Require a verified matching email").check();
  await screenshot(page, "admin-invite-verified-email");
  await invite.getByRole("button", { name: "Create invitation" }).click();
  const created = page.getByRole("dialog", { name: "Invitation created" });
  const link = await created.getByRole("group", { name: "Invitation link" }).locator("code").innerText();
  await created.getByRole("button", { name: "Done" }).click();
  const row = page
    .getByRole("table", { name: "Invitations" })
    .getByRole("row")
    .filter({ hasText: `${invited}@example.com` });
  await expect(row.getByText("Verified email required")).toBeVisible();
  await screenshot(page, "admin-invitations-verified-email");

  // Another account's verified email doesn't match: nothing is created, and the link still works.
  const wrong = await personAs(browser, stranger);
  await wrong.goto(link);
  await expect(wrong.getByText("Sign in with an account whose verified email is the one this invitation was sent to.")).toBeVisible();
  await wrong.getByLabel("Username").fill(`vera-${suffix}`);
  await wrong.getByLabel("Display name").fill("Vera Verified");
  await wrong.getByRole("button", { name: `Continue with ${providerName}` }).click();
  await expect(wrong.getByText("That account's verified email is not the one this invitation is for.", { exact: false })).toBeVisible();
  await screenshot(wrong, "invitation-email-mismatch");
  await wrong.context().close();

  const right = await personAs(browser, invited);
  await right.goto(link);
  await right.getByLabel("Username").fill(`vera-${suffix}`);
  await right.getByLabel("Display name").fill("Vera Verified");
  await right.getByRole("button", { name: `Continue with ${providerName}` }).click();
  await expect(right).toHaveURL("/files");
  await expect(right.getByRole("button", { name: "Account: Vera Verified" })).toBeVisible();
  await right.context().close();

  expect(errors).toEqual([]);
});
