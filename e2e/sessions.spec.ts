import { expect, test } from "@playwright/test";
import { seedUserWithSession, sessionCookie } from "./fixtures.ts";

/**
 * The session cookie is `SameSite=Strict` (threat model T2), so the browser leaves it off a
 * navigation that starts on another site. The SPA's HTML needs no cookie and its API calls are
 * same-site, so a signed-in user who follows a link from elsewhere (an email, an SSO redirect) is
 * still signed in once the app loads.
 */
test("a signed-in user who arrives from a cross-site link is still signed in", async ({ page, baseURL }) => {
  const origin = baseURL ?? "";
  const user = seedUserWithSession("cora");
  await page.context().addCookies([sessionCookie(origin, user.sessionToken)]);
  const elsewhere = "https://elsewhere.example/";
  await page.route(elsewhere, (route) =>
    route.fulfill({ contentType: "text/html", body: `<a href="${origin}/settings/sessions">Your sessions</a>` }),
  );

  await page.goto(elsewhere);
  const documentRequest = page.waitForRequest(`${origin}/settings/sessions`);
  await page.getByRole("link", { name: "Your sessions" }).click();
  // The navigation itself is cross-site, so the Strict cookie isn't on it.
  expect((await (await documentRequest).allHeaders())["cookie"] ?? "").not.toContain("__Host-nu_session");

  await expect(page).toHaveURL(`${origin}/settings/sessions`);
  await expect(page.getByRole("table", { name: "Your sessions" })).toBeVisible();
});
