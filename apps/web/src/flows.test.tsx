import { problemTypes } from "@not-unreachable/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  adminSession,
  baseHandlers,
  json,
  problem,
  renderApp,
  requestsTo,
  stubApi,
  userSession,
  type MockHandler,
} from "./testing/index.ts";

const token = "A".repeat(43);

function locationOf(router: ReturnType<typeof renderApp>["router"]): string {
  return router.state.location.pathname + router.state.location.search;
}

function type(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("setup", () => {
  it("creates the admin with the token from the fragment, takes the token out of the address and goes to sign-in", async () => {
    const fetchMock = stubApi({ ...baseHandlers({ adminExists: false }), "POST /api/v1/setup": () => json(200, { username: "ada" }) });
    const { router } = renderApp(`/setup#${token}`);

    await screen.findByRole("heading", { level: 1, name: "Create the admin account" });
    await waitFor(() => expect(router.state.location.hash).toBe(""));
    type("Username", "ada");
    type("Email", "ada@example.com");
    type("Display name", "Ada Admin");
    type(/^Password/, "correct horse battery");
    type("Confirm password", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }));

    expect(await screen.findByText("Admin account created. Sign in to continue.")).toBeDefined();
    expect(locationOf(router)).toBe("/sign-in");
    expect(requestsTo(fetchMock, "POST /api/v1/setup").map((request) => request.body)).toEqual([
      { token, username: "ada", email: "ada@example.com", displayName: "Ada Admin", password: "correct horse battery" },
    ]);
  });

  it("sets a new password for the existing admin with an admin-reset link: only the token and the password", async () => {
    const fetchMock = stubApi({ ...baseHandlers({ adminExists: true }), "POST /api/v1/setup": () => json(200, { username: "ada" }) });
    const { router } = renderApp(`/setup#${token}`);

    await screen.findByRole("heading", { level: 1, name: "Set a new admin password" });
    expect(screen.queryByLabelText("Username")).toBeNull();
    type("New password", "correct horse battery");
    type("Confirm password", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText("Admin password set. Sign in to continue.")).toBeDefined();
    expect(locationOf(router)).toBe("/sign-in");
    expect(requestsTo(fetchMock, "POST /api/v1/setup").map((request) => request.body)).toEqual([
      { token, password: "correct horse battery" },
    ]);
  });

  it("says the link is not valid without a token, or when the server refuses it", async () => {
    stubApi(baseHandlers({ adminExists: false }));
    const { view } = renderApp("/setup");
    expect(await screen.findByText("This setup link is not valid")).toBeDefined();
    view.unmount();

    stubApi({ ...baseHandlers({ adminExists: true }), "POST /api/v1/setup": () => problem(404, problemTypes.notFound) });
    renderApp(`/setup#${token}`);
    await screen.findByRole("heading", { level: 1, name: "Set a new admin password" });
    type("New password", "correct horse battery");
    type("Confirm password", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("This setup link is not valid")).toBeDefined();
    expect(screen.getByText("not-unreachable reset-admin")).toBeDefined();
  });

  it("takes up a link opened in a tab already on /setup, and keeps its token when an invalid hash follows", async () => {
    const fetchMock = stubApi({ ...baseHandlers({ adminExists: true }), "POST /api/v1/setup": () => json(200, { username: "ada" }) });
    const { router } = renderApp("/setup");
    expect(await screen.findByText("This setup link is not valid")).toBeDefined();
    const heading = screen.getByRole("heading", { level: 1, name: "Set a new admin password" });

    await act(() => router.navigate(`/setup#${token}`));
    expect(await screen.findByRole("button", { name: "Set password" })).toBeDefined();
    await waitFor(() => expect(router.state.location.hash).toBe(""));

    await act(() => router.navigate("/setup#not-a-token"));
    await waitFor(() => expect(router.state.location.hash).toBe(""));
    expect(screen.getByRole("heading", { level: 1, name: "Set a new admin password" })).toBe(heading);
    expect(screen.queryByText("This setup link is not valid")).toBeNull();

    type("New password", "correct horse battery");
    type("Confirm password", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("Admin password set. Sign in to continue.")).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/setup").map((request) => request.body)).toEqual([
      { token, password: "correct horse battery" },
    ]);
  });

  it("shows the form again for a new link opened in the same tab after the server refused the old one", async () => {
    const newToken = "B".repeat(43);
    stubApi({ ...baseHandlers({ adminExists: true }), "POST /api/v1/setup": () => problem(404, problemTypes.notFound) });
    const { router } = renderApp(`/setup#${token}`);
    await screen.findByRole("heading", { level: 1, name: "Set a new admin password" });
    type("New password", "correct horse battery");
    type("Confirm password", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("This setup link is not valid")).toBeDefined();

    await act(() => router.navigate(`/setup#${newToken}`));
    expect(await screen.findByRole("button", { name: "Set password" })).toBeDefined();
    expect(screen.queryByText("This setup link is not valid")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("New password").value).toBe("");
  });
});

/** Signed out until POST /sign-in answers with the session. */
function signInHandlers(answer: MockHandler, session = adminSession): Record<string, MockHandler> {
  let signedIn = false;
  return {
    ...baseHandlers(),
    "GET /api/v1/session": () => (signedIn ? json(200, session) : problem(401, problemTypes.signInRequired)),
    "POST /api/v1/sign-in": async (request) => {
      const response = await answer(request);
      if (response.ok) signedIn = true;
      return response;
    },
  };
}

function submit(identifier = "ada", password = "secret password"): void {
  type("Username or email", identifier);
  type("Password", password);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("sign-in", () => {
  it.each([
    [problemTypes.signInFailed, 401, "The username, email or password is not right."],
    [problemTypes.tooManyAttempts, 429, "Too many sign-in attempts. Wait a few minutes and try again."],
  ])("shows an Alert for %s and clears the password", async (problemType, status, message) => {
    stubApi(signInHandlers(() => problem(status, problemType)));
    renderApp("/sign-in");
    await screen.findByRole("heading", { level: 1, name: "Sign in" });

    submit();

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("");
  });

  it.each([
    ["admin", adminSession, "/admin/audit-log", "Audit log"],
    ["user", userSession, "/files", "Files"],
  ] as const)("lands the %s in its own interface", async (_role, session, path, heading) => {
    stubApi(signInHandlers(() => json(200, session), session));
    const { router } = renderApp("/sign-in");
    await screen.findByRole("heading", { level: 1, name: "Sign in" });

    submit();

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeDefined();
    expect(locationOf(router)).toBe(path);
  });

  it.each([
    ["/settings/sessions", "/settings/sessions"],
    ["//evil.example", "/admin/audit-log"],
    ["/\\evil.example", "/admin/audit-log"],
    ["https://evil.example/admin", "/admin/audit-log"],
    ["/files", "/admin/audit-log"],
  ])("goes on to ?next=%s only when it is safe", async (next, landsOn) => {
    stubApi({
      ...signInHandlers(() => json(200, adminSession)),
      "GET /api/v1/settings/sessions": () => json(200, { sessions: [] }),
    });
    const { router } = renderApp(`/sign-in?next=${encodeURIComponent(next)}`);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });

    submit();

    await waitFor(() => expect(locationOf(router)).toBe(landsOn));
  });
});

describe("recent sign-in", () => {
  it("asks for the password when the server answers recent-sign-in-required, then runs the action again", async () => {
    let confirmed = false;
    const fetchMock = stubApi({
      ...baseHandlers({ session: adminSession }),
      "GET /api/v1/settings/profile": () => json(200, adminSession.account),
      "PATCH /api/v1/settings/profile": () =>
        confirmed ? json(200, { ...adminSession.account, email: "new@example.com" }) : problem(403, problemTypes.recentSignInRequired),
      "POST /api/v1/session/confirm": (request) => {
        const body = request.body;
        if (typeof body !== "object" || body === null || !("password" in body) || body.password !== "right password")
          return problem(401, problemTypes.signInFailed);
        confirmed = true;
        return json(200, adminSession);
      },
    });
    renderApp("/settings/profile");
    await screen.findByRole("heading", { level: 1, name: "Account settings" });
    await screen.findByDisplayValue(adminSession.account.email ?? "");

    type("Email", "new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Password"));
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "wrong password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByText("The password is not right.")).toBeDefined();

    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "right password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Profile saved")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
    expect(requestsTo(fetchMock, "PATCH /api/v1/settings/profile").map((request) => request.body)).toEqual([
      { email: "new@example.com" },
      { email: "new@example.com" },
    ]);
  });

  it("drops the action without an error when the dialog is cancelled", async () => {
    const fetchMock = stubApi({
      ...baseHandlers({ session: adminSession }),
      "GET /api/v1/settings/profile": () => json(200, adminSession.account),
      "PATCH /api/v1/settings/profile": () => problem(403, problemTypes.recentSignInRequired),
    });
    renderApp("/settings/profile");
    await screen.findByDisplayValue(adminSession.account.email ?? "");

    type("Email", "new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(requestsTo(fetchMock, "PATCH /api/v1/settings/profile")).toHaveLength(1);
  });

  it("drops the action and goes to sign-in when the session ends while asking", async () => {
    stubApi({
      ...baseHandlers({ session: adminSession }),
      "GET /api/v1/settings/profile": () => json(200, adminSession.account),
      "PATCH /api/v1/settings/profile": () => problem(403, problemTypes.recentSignInRequired),
      "POST /api/v1/session/confirm": () => problem(401, problemTypes.signInRequired),
    });
    const { router } = renderApp("/settings/profile");
    await screen.findByDisplayValue(adminSession.account.email ?? "");

    type("Email", "new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "right password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(locationOf(router)).toBe(`/sign-in?next=${encodeURIComponent("/settings/profile")}`));
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
  });
});

describe("password settings", () => {
  it("doesn't invite autofilling the current password, and marks the new ones as new", async () => {
    stubApi(baseHandlers({ session: adminSession }));
    renderApp("/settings/password");
    await screen.findByRole("heading", { level: 1, name: "Account settings" });

    expect((await screen.findByLabelText("Current password")).getAttribute("autocomplete")).toBe("off");
    expect(screen.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Confirm new password").getAttribute("autocomplete")).toBe("new-password");
  });
});

describe("wrong-role access", () => {
  it.each([
    ["user", userSession, "/admin/settings/security", "/files"],
    ["admin", adminSession, "/files", "/admin/audit-log"],
  ] as const)("sends the %s from %s to its own interface", async (_role, session, path, landsOn) => {
    stubApi(baseHandlers({ session }));
    const { router } = renderApp(path);
    await waitFor(() => expect(locationOf(router)).toBe(landsOn));
  });
});
