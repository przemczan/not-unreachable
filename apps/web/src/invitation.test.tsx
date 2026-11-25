import { problemTypes, type SignInProvider } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserNavigation } from "./lib/index.ts";
import { baseHandlers, json, problem, renderApp, requestsTo, stubApi, type MockHandler } from "./testing/index.ts";

const google: SignInProvider = { id: "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a01", kind: "google", name: "Google" };
const github: SignInProvider = { id: "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a02", kind: "github", name: "GitHub" };

const token = "k3xV9q2Lr8bN0mWc5tYh1pZa7sDf4gJe6uIo2nBv3Qw";
const providerUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=x";

function stubNavigation() {
  return vi.spyOn(browserNavigation, "assign").mockImplementation(() => undefined);
}

function invitationHandlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    ...baseHandlers(),
    [`GET /api/v1/invitations/${token}`]: () => json(200, { providers: [google, github], suggestedUsername: "una", verifyEmail: false }),
    ...extra,
  };
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => sessionStorage.clear());

describe("the invitation page", () => {
  it("suggests a username, then starts signing in with the chosen provider", async () => {
    const assign = stubNavigation();
    const fetchMock = stubApi(invitationHandlers({ [`POST /api/v1/invitations/${token}/accept`]: () => json(200, { url: providerUrl }) }));
    renderApp(`/invitation/${token}`);

    expect(await screen.findByRole("heading", { level: 1, name: "Create your account" })).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Username").value).toBe("una");
    expect(screen.getByText("3–32 lowercase letters, digits, dots, dashes or underscores. It can't change later.")).toBeDefined();
    type("Display name", "  Una User ");
    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(providerUrl));
    expect(requestsTo(fetchMock, `POST /api/v1/invitations/${token}/accept`).map((request) => request.body)).toEqual([
      { providerId: github.id, username: "una", displayName: "Una User" },
    ]);
  });

  it("checks the fields before leaving for the provider", async () => {
    const fetchMock = stubApi(invitationHandlers());
    renderApp(`/invitation/${token}`);

    await screen.findByRole("heading", { level: 1, name: "Create your account" });
    type("Username", "Una!");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(await screen.findByText("Use 3–32 lowercase letters, digits, dots, dashes or underscores.")).toBeDefined();
    expect(screen.getByText("Enter a name of up to 100 characters.")).toBeDefined();
    expect(requestsTo(fetchMock, `POST /api/v1/invitations/${token}/accept`)).toHaveLength(0);
  });

  it("shows a taken username on its field", async () => {
    stubApi(invitationHandlers({ [`POST /api/v1/invitations/${token}/accept`]: () => problem(409, problemTypes.usernameTaken) }));
    renderApp(`/invitation/${token}`);

    await screen.findByRole("heading", { level: 1, name: "Create your account" });
    type("Display name", "Una User");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(await screen.findByText("This username is taken.")).toBeDefined();
  });

  it("says the link is not valid when the server doesn't know it", async () => {
    stubApi({ ...baseHandlers(), [`GET /api/v1/invitations/${token}`]: () => problem(404, problemTypes.invitationInvalid) });
    renderApp(`/invitation/${token}`);

    expect(await screen.findByRole("heading", { level: 1, name: "This link is not valid" })).toBeDefined();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("says the link is not valid when the provider's round trip comes back with invitation-invalid", async () => {
    const fetchMock = stubApi(invitationHandlers());
    renderApp(`/invitation/${token}?error=invitation-invalid`);

    expect(await screen.findByRole("heading", { level: 1, name: "This link is not valid" })).toBeDefined();
    expect(requestsTo(fetchMock, `GET /api/v1/invitations/${token}`)).toHaveLength(0);
  });

  it("explains an identity already linked to another account, naming the provider used", async () => {
    sessionStorage.setItem(
      "invitation-draft",
      JSON.stringify({ token, providerId: google.id, username: "una.u", displayName: "Una User" }),
    );
    stubApi(invitationHandlers());
    renderApp(`/invitation/${token}?error=identity-already-linked`);

    expect(
      await screen.findByText("This Google account is already linked to another account. Sign in with it instead, or use another one."),
    ).toBeDefined();
    // What was typed before leaving for the provider is back.
    expect(screen.getByLabelText<HTMLInputElement>("Username").value).toBe("una.u");
    expect(screen.getByLabelText<HTMLInputElement>("Display name").value).toBe("Una User");
  });

  it("shows the verified-email note only when the invitation requires it", async () => {
    stubApi(invitationHandlers());
    const first = renderApp(`/invitation/${token}`);
    await screen.findByRole("heading", { level: 1, name: "Create your account" });
    expect(screen.queryByText(/verified email is the one/)).toBeNull();
    first.view.unmount();

    stubApi(
      invitationHandlers({
        [`GET /api/v1/invitations/${token}`]: () => json(200, { providers: [google], suggestedUsername: null, verifyEmail: true }),
      }),
    );
    renderApp(`/invitation/${token}`);
    expect(await screen.findByText(/verified email is the one this invitation was sent to/)).toBeDefined();
  });

  it("explains an email the provider did not verify", async () => {
    stubApi(invitationHandlers());
    renderApp(`/invitation/${token}?error=email-not-verified`);

    expect(await screen.findByText(/did not report a verified email/)).toBeDefined();
  });

  it("explains an email that is not the invitation's", async () => {
    stubApi(invitationHandlers());
    renderApp(`/invitation/${token}?error=email-mismatch`);

    expect(await screen.findByText(/not the one this invitation is for/)).toBeDefined();
  });

  it("asks to contact the admin when no provider is turned on", async () => {
    stubApi({
      ...baseHandlers(),
      [`GET /api/v1/invitations/${token}`]: () => json(200, { providers: [], suggestedUsername: null, verifyEmail: false }),
    });
    renderApp(`/invitation/${token}`);

    expect(await screen.findByText(/Ask the admin to set one up/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Continue with/ })).toBeNull();
  });
});

describe("the re-link page", () => {
  it("starts signing in with the chosen provider", async () => {
    const assign = stubNavigation();
    const fetchMock = stubApi({
      ...baseHandlers(),
      [`GET /api/v1/relink/${token}`]: () => json(200, { providers: [google] }),
      [`POST /api/v1/relink/${token}/start`]: () => json(200, { url: providerUrl }),
    });
    renderApp(`/relink/${token}`);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(providerUrl));
    expect(requestsTo(fetchMock, `POST /api/v1/relink/${token}/start`).map((request) => request.body)).toEqual([{ providerId: google.id }]);
  });

  it("says the link is not valid when the server doesn't know it", async () => {
    stubApi({ ...baseHandlers(), [`GET /api/v1/relink/${token}`]: () => problem(404, problemTypes.invitationInvalid) });
    renderApp(`/relink/${token}`);

    expect(await screen.findByRole("heading", { level: 1, name: "This link is not valid" })).toBeDefined();
  });

  it("explains an identity already linked to another account", async () => {
    stubApi({ ...baseHandlers(), [`GET /api/v1/relink/${token}`]: () => json(200, { providers: [google] }) });
    renderApp(`/relink/${token}?error=identity-already-linked`);

    expect(await screen.findByText("This account is already linked to another account. Use another one.")).toBeDefined();
  });
});
