import { expect, test, type Page } from "@playwright/test";
import {
  admin,
  enrolmentCode,
  expectNoViolations,
  raiseSignInLimitsForTheRun,
  recoveryCodesFileName,
  saveAdminSecondFactor,
  screenshot,
  seedAdminSession,
  seedFirstRunSetupToken,
  seedUserWithSession,
  sessionCookie,
  signInAsAdmin,
  watchViolations,
} from "./fixtures.ts";

/**
 * One instance, one database: the tests run in order, from first-run setup (no admin yet) to the
 * admin's and a user's interfaces.
 */
test.describe.configure({ mode: "serial" });

// The setup project runs first, so this holds for every spec's sign-ins.
test.beforeAll(raiseSignInLimitsForTheRun);

/** Records the URLs of the Geist font files the page fetched. */
function watchFonts(page: Page): string[] {
  const fonts: string[] = [];
  page.on("response", (response) => {
    if (/\/Geist-Variable[^/]*\.woff2$/.test(new URL(response.url()).pathname) && response.ok()) fonts.push(response.url());
  });
  return fonts;
}

/** Whether the page shows its text in Geist, once every font in use has loaded. */
async function geistLoaded(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check("12px Geist");
  });
}

type Layout = "auth" | "admin" | "user";

/** Checks the screen is in its layout: AuthLayout's card, the admin Sidebar, or the user's Topbar navigation. */
async function expectLayout(page: Page, layout: Layout, heading: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByText("NotUnreachable", { exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  const bannerNav = page.getByRole("banner").getByRole("navigation", { name: "Main" });
  switch (layout) {
    case "auth":
      await expect(page.getByRole("region", { name: heading })).toBeVisible();
      await expect(page.getByRole("navigation")).toHaveCount(0);
      break;
    case "admin":
      await expect(nav).toBeVisible();
      await expect(bannerNav).toHaveCount(0);
      await expect(nav.getByRole("link", { name: "Audit log" })).toHaveAttribute("href", "/admin/audit-log");
      await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/admin/settings");
      await expect(page.getByRole("banner").getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
      break;
    case "user":
      await expect(bannerNav).toBeVisible();
      await expect(bannerNav.getByRole("link", { name: "Files" })).toHaveAttribute("aria-current", "page");
      break;
  }
}

test("every page sends to /setup while no admin exists, and a link without a token says it is not valid", async ({ page }) => {
  const problems = await watchViolations(page);
  const fonts = watchFonts(page);

  for (const path of ["/", "/sign-in", "/admin", "/files", "/settings/sessions"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain("require-trusted-types-for 'script'");
    await expect(page).toHaveURL("/setup");
    await expectLayout(page, "auth", "Create the admin account");
  }
  await expect(page.getByText("This setup link is not valid")).toBeVisible();
  expect(await geistLoaded(page)).toBe(true);
  await expectNoViolations(page, problems);
  const origin = new URL(page.url()).origin;
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((url) => new URL(url).origin === origin)).toBe(true);
});

test("setup creates the admin from the link's token, then sends to sign-in", async ({ page }) => {
  const problems = await watchViolations(page);
  const token = seedFirstRunSetupToken();

  await page.goto(`/setup#${token}`);

  await expectLayout(page, "auth", "Create the admin account");
  // The token leaves the address bar at once.
  await expect(page).toHaveURL("/setup");
  await page.getByLabel("Username").fill(admin.username);
  await page.getByLabel("Email").fill(admin.email);
  await page.getByLabel("Display name").fill(admin.displayName);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByLabel("Confirm password").fill(admin.password);
  await screenshot(page, "setup");
  await page.getByRole("button", { name: "Create admin account" }).click();

  await expect(page).toHaveURL("/sign-in");
  await expectLayout(page, "auth", "Sign in");
  await expect(page.getByText("Admin account created. Sign in to continue.")).toBeVisible();
  await expectNoViolations(page, problems);
});

test("sign-in shows an Alert for a wrong password, then lands the admin on the audit log", async ({ page }) => {
  const problems = await watchViolations(page);

  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");
  await expectLayout(page, "auth", "Sign in");
  await page.getByLabel("Username or email").fill(admin.username);
  await page.getByLabel("Password", { exact: true }).fill("not the password at all");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The username, email or password is not right." })).toBeVisible();
  await screenshot(page, "sign-in");

  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // The admin has no second factor yet: adding an authenticator app comes first.
  await expect(page).toHaveURL("/sign-in/second-factor");
  await expectLayout(page, "auth", "Set up two-step sign-in");
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const setupKey = (await page.getByRole("group", { name: "Setup key" }).locator("code").textContent()) ?? "";
  expect(setupKey).toMatch(/^[A-Z2-7]{16,}$/);
  await screenshot(page, "second-factor-enrol");
  // A passkey can be added instead; going back keeps the same setup key.
  await page.getByRole("button", { name: "Add a passkey instead" }).click();
  await expect(page.getByText("Add a passkey to your account before you go on.")).toBeVisible();
  await expect(page.getByLabel("Passkey name")).toBeVisible();
  await screenshot(page, "second-factor-enrol-passkey");
  await page.getByRole("button", { name: "Add an authenticator app instead" }).click();
  await expect(page.getByRole("group", { name: "Setup key" }).locator("code")).toHaveText(setupKey);
  const { code, step } = enrolmentCode(setupKey);
  await page.getByRole("group", { name: "Authenticator code" }).getByRole("textbox", { name: "Digit 1 of 6" }).fill(code);
  await page.getByRole("button", { name: "Add authenticator app" }).click();

  await expectLayout(page, "auth", "Save your recovery codes");
  const recoveryCodes = ((await page.getByRole("group", { name: "Recovery codes" }).locator("code").textContent()) ?? "").split("\n");
  expect(recoveryCodes).toHaveLength(10);
  expect(recoveryCodes.every((recoveryCode) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(recoveryCode))).toBe(true);
  saveAdminSecondFactor(setupKey, recoveryCodes, step);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download codes" }).click();
  expect((await download).suggestedFilename()).toBe(recoveryCodesFileName);
  const proceed = page.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  await page.getByLabel("I saved my recovery codes").check();
  await screenshot(page, "second-factor-recovery-codes");
  await proceed.click();

  await expect(page).toHaveURL("/admin/audit-log");
  await expectLayout(page, "admin", "Audit log");
  await expect(page.getByText(/Times are in /)).toBeVisible();
  const events = page.getByRole("listitem");
  await expect(events.filter({ hasText: "Setup completed" })).toHaveCount(1);
  await expect(events.filter({ hasText: "Authenticator app added" })).toHaveCount(1);
  await expect(events.filter({ hasText: "Sign-in failed" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
  await screenshot(page, "admin-audit-log");

  await page.getByRole("button", { name: "Details" }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Event ID")).toBeVisible();
  await screenshot(page, "admin-audit-log-details");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/admin/settings/security");
  await expectLayout(page, "admin", "Settings");
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Security" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByLabel("Admin idle timeout")).toBeVisible();
  await screenshot(page, "admin-settings-security");

  await page.goto("/settings/sessions");
  await expectLayout(page, "admin", "Account settings");
  await expect(page.getByRole("table", { name: "Your sessions" })).toBeVisible();
  await expect(page.getByText("This session")).toBeVisible();
  await screenshot(page, "settings-sessions");

  await expectNoViolations(page, problems);
});

test("sign-in follows a safe ?next= and refuses an unsafe one", async ({ page }) => {
  const problems = await watchViolations(page);

  await signInAsAdmin(page, `/sign-in?next=${encodeURIComponent("//evil.example/admin")}`);
  await expect(page).toHaveURL("/admin/audit-log");

  await page.context().clearCookies();
  await signInAsAdmin(page, `/sign-in?next=${encodeURIComponent("/settings/sessions")}`);
  await expect(page).toHaveURL("/settings/sessions");
  await expectNoViolations(page, problems);
});

test("the theme switch shows the admin interface dark and remembers it on every page", async ({ page, baseURL }) => {
  const problems = await watchViolations(page);
  await page.context().addCookies([sessionCookie(baseURL ?? "", seedAdminSession())]);
  await page.goto("/");
  await expect(page).toHaveURL("/admin/audit-log");

  await page.getByRole("button", { name: "Switch to dark theme" }).click();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
  await page.goto("/admin/settings/security");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoViolations(page, problems);
});

test("signing out ends the session and goes to sign-in", async ({ page, baseURL }) => {
  const problems = await watchViolations(page);
  await page.context().addCookies([sessionCookie(baseURL ?? "", seedAdminSession())]);
  await page.goto("/admin/audit-log");
  await expect(page).toHaveURL("/admin/audit-log");

  await page.getByRole("button", { name: `Account: ${admin.displayName}` }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  await expect(page).toHaveURL("/sign-in");
  await page.goto("/admin/audit-log");
  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent("/admin/audit-log")}`);
  await expectNoViolations(page, problems);
});

test("a user lands on /files, in the user interface, and is sent back there from /admin", async ({ page, baseURL }) => {
  const problems = await watchViolations(page);
  const user = seedUserWithSession();
  await page.context().addCookies([sessionCookie(baseURL ?? "", user.sessionToken)]);

  await page.goto("/");

  await expect(page).toHaveURL("/files");
  await expectLayout(page, "user", "Files");
  // The fixture's user has no home (accepting an invitation makes one): Files says so.
  await expect(page.getByText("You have no home folder yet.")).toBeVisible();
  await screenshot(page, "user-files");

  await page.goto("/admin/audit-log");
  await expect(page).toHaveURL("/files");

  await page.goto("/settings/password");
  await expect(page).toHaveURL("/settings/profile");
  await expect(page.getByRole("navigation", { name: "Account settings sections" }).getByRole("link", { name: "Password" })).toHaveCount(0);
  await expectNoViolations(page, problems);
});

test("the page links the brand icons as same-origin files", async ({ page, request }) => {
  await page.goto("/sign-in");

  for (const rel of ["icon", "apple-touch-icon"]) {
    const href = await page.locator(`link[rel="${rel}"]`).getAttribute("href");
    expect(href).toMatch(/^\/assets\//);
    const icon = await request.get(href ?? "");
    expect(icon.status()).toBe(200);
  }
});
