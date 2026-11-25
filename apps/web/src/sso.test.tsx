import { problemTypes, type LinkedSignIn, type Session, type SignInProvider } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { browserNavigation } from "./lib/index.ts";
import {
  adminSession,
  baseHandlers,
  json,
  noContent,
  problem,
  renderApp,
  requestsTo,
  stubApi,
  userSession,
  type MockHandler,
} from "./testing/index.ts";

const google: SignInProvider = { id: "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a01", kind: "google", name: "Google" };
const github: SignInProvider = { id: "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a02", kind: "github", name: "GitHub" };

const googleLink: LinkedSignIn = {
  id: "8b2f3c4d-5e6f-4a70-9b8c-0d1e2f3a4b01",
  providerId: google.id,
  providerName: "Google",
  providerKind: "google",
  providerEnabled: true,
  email: "una@example.com",
  createdAt: "2026-11-20T10:00:00.000Z",
  lastUsedAt: null,
  removable: false,
};

const githubLink: LinkedSignIn = {
  ...googleLink,
  id: "8b2f3c4d-5e6f-4a70-9b8c-0d1e2f3a4b02",
  providerId: github.id,
  providerName: "GitHub",
  providerKind: "github",
  providerEnabled: false,
  email: null,
  lastUsedAt: "2026-11-21T10:00:00.000Z",
  removable: true,
};

function locationOf(router: ReturnType<typeof renderApp>["router"]): string {
  return router.state.location.pathname + router.state.location.search;
}

function stubNavigation() {
  return vi.spyOn(browserNavigation, "assign").mockImplementation(() => undefined);
}

describe("signing in with a provider", () => {
  it("offers each enabled provider below the password form and starts its sign-in", async () => {
    const assign = stubNavigation();
    const fetchMock = stubApi({
      ...baseHandlers(),
      "GET /api/v1/sso/providers": () => json(200, { providers: [google, github] }),
      [`POST /api/v1/sso/${google.id}/start`]: () => json(200, { url: "https://accounts.google.com/o/oauth2/v2/auth?state=x" }),
    });
    renderApp("/sign-in");

    const button = await screen.findByRole("button", { name: "Continue with Google" });
    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeDefined();
    expect(screen.getByText("or")).toBeDefined();

    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=x"));
    expect(requestsTo(fetchMock, `POST /api/v1/sso/${google.id}/start`)).toHaveLength(1);
  });

  it("keeps ?next= in this tab while away at the provider", async () => {
    sessionStorage.clear();
    stubNavigation();
    stubApi({
      ...baseHandlers(),
      "GET /api/v1/sso/providers": () => json(200, { providers: [google] }),
      [`POST /api/v1/sso/${google.id}/start`]: () => json(200, { url: "https://accounts.google.com/o/oauth2/v2/auth?state=x" }),
    });
    renderApp(`/sign-in?next=${encodeURIComponent("/s/abc")}`);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(sessionStorage.getItem("sign-in-next")).toBe("/s/abc"));
  });

  it("shows no divider or provider buttons without providers", async () => {
    stubApi(baseHandlers());
    renderApp("/sign-in");

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    await waitFor(() => expect(screen.queryByText("or")).toBeNull());
    expect(screen.queryByRole("button", { name: /Continue with/ })).toBeNull();
  });

  it("says the provider could not be reached when its start fails, and the page stays usable", async () => {
    const assign = stubNavigation();
    stubApi({
      ...baseHandlers(),
      "GET /api/v1/sso/providers": () => json(200, { providers: [google, github] }),
      [`POST /api/v1/sso/${google.id}/start`]: () => problem(502, problemTypes.ssoProviderUnreachable),
    });
    renderApp("/sign-in");

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByText("The provider could not be reached. Try again later.")).toBeDefined();
    expect(assign).not.toHaveBeenCalled();
    for (const name of ["Continue with Google", "Continue with GitHub", "Sign in"]) {
      expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(false);
    }
  });

  it("makes the provider buttons work again when the browser comes back from the provider's page", async () => {
    stubNavigation();
    stubApi({
      ...baseHandlers(),
      "GET /api/v1/sso/providers": () => json(200, { providers: [google, github] }),
      [`POST /api/v1/sso/${google.id}/start`]: () => json(200, { url: "https://accounts.google.com/o/oauth2/v2/auth?state=x" }),
    });
    renderApp("/sign-in");

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    const other = screen.getByRole<HTMLButtonElement>("button", { name: "Continue with GitHub" });
    await waitFor(() => expect(other.disabled).toBe(true));
    // Leaving for the provider's page doesn't end the page when it is kept for Back: nothing resets it then.
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: false }));
    expect(other.disabled).toBe(true);
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    await waitFor(() => expect(other.disabled).toBe(false));
  });

  it("offers to load the providers again when they could not be loaded, keeping the password form", async () => {
    let fail = true;
    stubApi({
      ...baseHandlers(),
      "GET /api/v1/sso/providers": () => (fail ? problem(503, problemTypes.serviceUnavailable) : json(200, { providers: [google] })),
    });
    renderApp("/sign-in");

    // A 5xx is retried once, a second later, before the page says so.
    const message = "The other ways to sign in could not be loaded. You can still sign in with your password.";
    expect(await screen.findByText(message, {}, { timeout: 3000 })).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeDefined();
  });

  it("shows one neutral message when a provider's sign-in failed", async () => {
    stubApi(baseHandlers());
    renderApp("/sign-in?error=sign-in-failed");

    expect(await screen.findByText("We couldn't sign you in with that account. Try again, or use another way to sign in.")).toBeDefined();
  });
});

describe("/sign-in/complete", () => {
  it.each<[string, Session, string]>([
    ["the admin pending the second factor", { ...adminSession, state: "pendingSecondFactor" }, "/sign-in/second-factor"],
    ["the admin", adminSession, "/admin/audit-log"],
    ["a user", userSession, "/files"],
  ])("sends %s on", async (_who, session, expected) => {
    sessionStorage.clear();
    stubApi({
      ...baseHandlers({ session }),
      "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "verify", methods: ["totp", "recoveryCode"] }),
    });
    const { router } = renderApp("/sign-in/complete");

    await waitFor(() => expect(locationOf(router)).toBe(expected));
  });

  it.each<[string, Session, string | null, string]>([
    ["a user to the share page they came from", userSession, "/s/abc", "/s/abc"],
    ["the admin to the share page they came from", adminSession, "/s/abc", "/s/abc"],
    [
      "the second-factor step with the page carried on",
      { ...adminSession, state: "pendingSecondFactor" },
      "/s/abc",
      "/sign-in/second-factor?next=%2Fs%2Fabc",
    ],
    ["a user to the landing page for an unsafe page", userSession, "//evil.example/s/abc", "/files"],
  ])("sends %s, once", async (_what, session, kept, expected) => {
    sessionStorage.clear();
    if (kept !== null) sessionStorage.setItem("sign-in-next", kept);
    stubApi({
      ...baseHandlers({ session }),
      "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "verify", methods: ["totp", "recoveryCode"] }),
    });
    const { router } = renderApp("/sign-in/complete");

    await waitFor(() => expect(locationOf(router)).toBe(expected));
    expect(sessionStorage.getItem("sign-in-next")).toBeNull();
  });

  it("sends a visitor without a session back to sign in, with the neutral message", async () => {
    stubApi(baseHandlers());
    const { router } = renderApp("/sign-in/complete");

    expect(await screen.findByText("We couldn't sign you in with that account. Try again, or use another way to sign in.")).toBeDefined();
    expect(locationOf(router)).toBe("/sign-in?error=sign-in-failed");
  });
});

function linkedHandlers(session: Session, linkedSignIns: LinkedSignIn[], extra: Record<string, MockHandler> = {}) {
  return {
    ...baseHandlers({ session }),
    "GET /api/v1/settings/linked-sign-ins": () => json(200, { linkedSignIns }),
    "GET /api/v1/sso/providers": () => json(200, { providers: [google, github] }),
    ...extra,
  };
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Your linked sign-ins" }))
    .getByText(name)
    .closest("tr");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
}

describe("Settings → Linked sign-ins", () => {
  it("lists the linked sign-ins, and the last one can't be unlinked", async () => {
    stubApi(linkedHandlers(userSession, [googleLink]));
    renderApp("/settings/linked-sign-ins");

    await screen.findByRole("table", { name: "Your linked sign-ins" });
    const row = rowOf("Google");
    expect(within(row).getByText("una@example.com")).toBeDefined();
    expect(within(row).getByText("Never")).toBeDefined();
    expect(within(row).getByRole<HTMLButtonElement>("button", { name: "Unlink Google" }).disabled).toBe(true);
    expect(screen.getByText("Your last linked sign-in can't be unlinked. Link another one first.")).toBeDefined();
  });

  it("says when a linked sign-in's provider is turned off", async () => {
    stubApi(linkedHandlers(adminSession, [githubLink]));
    renderApp("/settings/linked-sign-ins");

    await screen.findByRole("table", { name: "Your linked sign-ins" });
    const row = rowOf("GitHub");
    expect(within(row).getByText("Provider turned off")).toBeDefined();
    expect(within(row).getByText("Not shared")).toBeDefined();
  });

  it("starts linking another provider", async () => {
    const assign = stubNavigation();
    const fetchMock = stubApi(
      linkedHandlers(userSession, [googleLink], {
        "POST /api/v1/settings/linked-sign-ins": () => json(200, { url: "https://github.com/login/oauth/authorize?state=x" }),
      }),
    );
    renderApp("/settings/linked-sign-ins");

    fireEvent.click(await screen.findByRole("button", { name: "Link GitHub" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=x"));
    expect(requestsTo(fetchMock, "POST /api/v1/settings/linked-sign-ins").map((request) => request.body)).toEqual([
      { providerId: github.id },
    ]);
  });

  it("unlinks after a confirmation", async () => {
    const fetchMock = stubApi(
      linkedHandlers(userSession, [{ ...googleLink, removable: true }, githubLink], {
        [`DELETE /api/v1/settings/linked-sign-ins/${githubLink.id}`]: () => noContent(),
      }),
    );
    renderApp("/settings/linked-sign-ins");

    await screen.findByRole("table", { name: "Your linked sign-ins" });
    fireEvent.click(within(rowOf("GitHub")).getByRole("button", { name: "Unlink GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink GitHub?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));

    expect(await screen.findByText("Sign-in unlinked")).toBeDefined();
    expect(requestsTo(fetchMock, `DELETE /api/v1/settings/linked-sign-ins/${githubLink.id}`)).toHaveLength(1);
  });

  it("explains a refused unlink of the last way to sign in", async () => {
    stubApi(
      linkedHandlers(userSession, [{ ...googleLink, removable: true }], {
        [`DELETE /api/v1/settings/linked-sign-ins/${googleLink.id}`]: () => problem(409, problemTypes.lastSignInMethod),
      }),
    );
    renderApp("/settings/linked-sign-ins");

    await screen.findByRole("table", { name: "Your linked sign-ins" });
    fireEvent.click(screen.getByRole("button", { name: "Unlink Google" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Unlink Google?" })).getByRole("button", { name: "Unlink" }));

    expect(await screen.findByText("This is your last way to sign in, so it can't be unlinked. Link another one first.")).toBeDefined();
  });

  it("asks a user to sign in again when linking needs a recent sign-in", async () => {
    stubApi(
      linkedHandlers(userSession, [googleLink], {
        "POST /api/v1/settings/linked-sign-ins": () => problem(403, problemTypes.recentSignInRequired),
      }),
    );
    renderApp("/settings/linked-sign-ins");

    fireEvent.click(await screen.findByRole("button", { name: "Link GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
    expect(within(dialog).getByRole("button", { name: "Sign in again" })).toBeDefined();
    expect(within(dialog).queryByLabelText("Password")).toBeNull();
  });

  it("says the provider could not be reached when linking can't start, and the buttons work again", async () => {
    const assign = stubNavigation();
    stubApi(
      linkedHandlers(userSession, [googleLink], {
        "POST /api/v1/settings/linked-sign-ins": () => problem(502, problemTypes.ssoProviderUnreachable),
      }),
    );
    renderApp("/settings/linked-sign-ins");

    fireEvent.click(await screen.findByRole("button", { name: "Link GitHub" }));
    expect(await screen.findByText("The provider could not be reached. Try again later.")).toBeDefined();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Link GitHub" }).disabled).toBe(false);
    expect(screen.getByRole("table", { name: "Your linked sign-ins" })).toBeDefined();
  });

  it("makes the Link buttons work again when the browser comes back from the provider's page", async () => {
    stubNavigation();
    stubApi(
      linkedHandlers(userSession, [googleLink], {
        "POST /api/v1/settings/linked-sign-ins": () => json(200, { url: "https://github.com/login/oauth/authorize?state=x" }),
      }),
    );
    renderApp("/settings/linked-sign-ins");

    fireEvent.click(await screen.findByRole("button", { name: "Link GitHub" }));
    const other = screen.getByRole<HTMLButtonElement>("button", { name: "Link Google" });
    await waitFor(() => expect(other.disabled).toBe(true));
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    await waitFor(() => expect(other.disabled).toBe(false));
  });

  it("offers to load the providers again when they could not be loaded, still listing the linked sign-ins", async () => {
    let fail = true;
    stubApi(
      linkedHandlers(userSession, [googleLink], {
        "GET /api/v1/sso/providers": () =>
          fail ? problem(503, problemTypes.serviceUnavailable) : json(200, { providers: [google, github] }),
      }),
    );
    renderApp("/settings/linked-sign-ins");

    expect(await screen.findByText("The sign-in providers could not be loaded", {}, { timeout: 3000 })).toBeDefined();
    expect(screen.getByRole("table", { name: "Your linked sign-ins" })).toBeDefined();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Link GitHub" })).toBeDefined();
  });

  it("shows that a provider was linked", async () => {
    stubApi(linkedHandlers(userSession, [googleLink, githubLink]));
    renderApp(`/settings/linked-sign-ins?linked=${github.id}`);

    expect(await screen.findByText("GitHub linked. You can sign in with it now.")).toBeDefined();
  });

  it.each([
    ["identity-already-linked", "This sign-in is already linked to an account."],
    ["link-failed", "Linking did not work. Try again."],
  ])("shows why a link was not made: %s", async (error, message) => {
    stubApi(linkedHandlers(userSession, [googleLink]));
    renderApp(`/settings/linked-sign-ins?error=${error}`);

    expect(await screen.findByText(message)).toBeDefined();
  });
});
