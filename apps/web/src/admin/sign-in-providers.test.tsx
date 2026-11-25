import { problemTypes, ssoProviderKinds, type SsoProvider } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adminSession, baseHandlers, json, problem, renderApp, requestsTo, stubApi, type MockHandler } from "../testing/index.ts";

const google: SsoProvider = {
  id: "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a01",
  kind: "google",
  name: "Google",
  issuer: "https://accounts.google.com",
  clientId: "client-1.apps.googleusercontent.com",
  clientSecretSet: true,
  enabled: true,
  redirectUri: "https://files.example.com/api/v1/sso/7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a01/callback",
  linkedSignIns: 0,
  createdAt: "2026-11-20T10:00:00.000Z",
};

const company: SsoProvider = {
  ...google,
  id: "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a02",
  kind: "oidc",
  name: "Company",
  issuer: "https://login.example.com",
  clientId: "files",
  redirectUri: "https://files.example.com/api/v1/sso/7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a02/callback",
  linkedSignIns: 3,
};

const path = "/api/v1/admin/sso-providers";
const publicOrigin = "https://files.example.com";

function handlers(providers: SsoProvider[], extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return { ...baseHandlers({ session: adminSession }), [`GET ${path}`]: () => json(200, { providers, publicOrigin }), ...extra };
}

/** The id an add request carries. */
const idOf = (body: unknown): string => z.object({ id: z.uuidv7() }).parse(body).id;

/** The value a CopyField shows. */
function copyFieldValue(container: HTMLElement, label: string): string | undefined {
  return within(container).getByRole("group", { name: label }).querySelector("code")?.textContent ?? undefined;
}

/** The "How to set this up" block, which is a native `<details>`. */
function helpOf(drawer: HTMLElement): HTMLDetailsElement {
  const help = within(drawer).getByText("How to set this up").closest("details");
  if (help === null) throw new Error("No setup help");
  return help;
}

async function openAddDrawer(): Promise<HTMLElement> {
  await openTab();
  fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
  return screen.findByRole("dialog", { name: "Add provider" });
}

async function openTab(): Promise<void> {
  renderApp("/admin/settings/sign-in-providers");
  await screen.findByRole("heading", { level: 1, name: "Settings" });
}

function rowOf(name: string): HTMLElement {
  // The name, not the kind (Google's provider is called Google too).
  const [cell] = within(screen.getByRole("table", { name: "Sign-in providers" })).getAllByText(name);
  const row = cell?.closest("tr");
  if (row == null) throw new Error(`No row for ${name}`);
  return row;
}

function type(container: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(container).getByLabelText(label), { target: { value } });
}

function openMenu(name: string): void {
  fireEvent.click(within(rowOf(name)).getByRole("button", { name: `Actions for ${name}` }));
}

describe("Admin settings → Sign-in providers", () => {
  it("lists each provider with its kind and whether it is on", async () => {
    stubApi(handlers([google, { ...company, enabled: false }]));
    await openTab();

    await screen.findByRole("table", { name: "Sign-in providers" });
    expect(within(rowOf("Google")).getByText("On")).toBeDefined();
    expect(within(rowOf("Company")).getByText("OpenID Connect")).toBeDefined();
    expect(within(rowOf("Company")).getByText("Off")).toBeDefined();
  });

  it("adds an OpenID Connect provider with the id its redirect URI was shown with, before it was added", async () => {
    // The server answers with the id it was sent, as it does.
    const addedWith = (body: unknown): SsoProvider => {
      const id = idOf(body);
      return { ...company, id, redirectUri: `${publicOrigin}/api/v1/sso/${id}/callback`, linkedSignIns: 0 };
    };
    const fetchMock = stubApi(handlers([], { [`POST ${path}`]: (request) => json(201, addedWith(request.body)) }));
    const drawer = await openAddDrawer();
    expect(within(drawer).queryByLabelText("Issuer")).toBeNull();
    const shown = copyFieldValue(drawer, "Redirect URI");
    expect(shown).toMatch(
      /^https:\/\/files\.example\.com\/api\/v1\/sso\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/callback$/,
    );

    fireEvent.click(within(drawer).getByRole("radio", { name: "OpenID Connect" }));
    type(drawer, "Name", "Company");
    type(drawer, "Issuer", "https://login.example.com");
    type(drawer, "Client ID", "files");
    type(drawer, "Client secret", "s3cret");
    fireEvent.click(within(drawer).getByRole("button", { name: "Add provider" }));

    expect(await screen.findByText("Provider added")).toBeDefined();
    const [request] = requestsTo(fetchMock, `POST ${path}`);
    expect(request?.body).toEqual({
      id: idOf(request?.body),
      kind: "oidc",
      name: "Company",
      issuer: "https://login.example.com",
      clientId: "files",
      clientSecret: "s3cret",
      enabled: true,
    });
    // What was registered at the provider is what the added provider has: nothing to change there.
    expect(addedWith(request?.body).redirectUri).toBe(shown);
  });

  it("makes a new id each time the Drawer opens to add a provider", async () => {
    stubApi(handlers([]));
    const drawer = await openAddDrawer();
    const first = copyFieldValue(drawer, "Redirect URI");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const again = await screen.findByRole("dialog", { name: "Add provider" });
    expect(copyFieldValue(again, "Redirect URI")).not.toBe(first);
  });

  it("keeps the browser and password managers from filling the client ID and secret with a saved sign-in", async () => {
    stubApi(handlers([]));
    const drawer = await openAddDrawer();
    const clientId = within(drawer).getByLabelText("Client ID");
    const clientSecret = within(drawer).getByLabelText("Client secret");
    expect(clientId.getAttribute("autocomplete")).toBe("off");
    expect(clientSecret.getAttribute("autocomplete")).toBe("new-password");
    for (const field of [clientId, clientSecret]) {
      expect(field.hasAttribute("data-1p-ignore")).toBe(true);
      expect(field.getAttribute("data-lpignore")).toBe("true");
      expect(field.hasAttribute("data-bwignore")).toBe(true);
    }
  });

  it("opens the setup help for a new provider, following the Kind", async () => {
    stubApi(handlers([]));
    const drawer = await openAddDrawer();
    expect(helpOf(drawer).open).toBe(true);

    const expected = {
      google: { step: "Authorized redirect URIs", link: "Google Auth Platform: Clients" },
      github: { step: "Authorization callback URL", link: "GitHub: OAuth Apps" },
      oidc: { step: "client_secret_post", link: "OpenID Connect Discovery" },
    } as const;
    for (const kind of ssoProviderKinds) {
      const label = { google: "Google", github: "GitHub", oidc: "OpenID Connect" }[kind];
      fireEvent.click(within(drawer).getByRole("radio", { name: label }));
      const help = helpOf(drawer);
      expect(within(help).getByText(expected[kind].step)).toBeDefined();
      expect(within(help).getByRole("link", { name: expected[kind].link }).getAttribute("target")).toBe("_blank");
      for (const other of ssoProviderKinds.filter((each) => each !== kind)) {
        expect(within(help).queryByText(expected[other].step)).toBeNull();
      }
    }
    // GitHub asks for the homepage: the server's own address.
    fireEvent.click(within(drawer).getByRole("radio", { name: "GitHub" }));
    expect(within(helpOf(drawer)).getByText(publicOrigin)).toBeDefined();
  });

  it("folds the setup help away when editing, showing the saved redirect URI", async () => {
    stubApi(handlers([google]));
    await openTab();

    await screen.findByRole("table", { name: "Sign-in providers" });
    openMenu("Google");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit provider" });
    expect(helpOf(drawer).open).toBe(false);
    expect(copyFieldValue(drawer, "Redirect URI")).toBe(google.redirectUri);
  });

  it("explains an id that is taken", async () => {
    stubApi(handlers([], { [`POST ${path}`]: () => problem(409, problemTypes.ssoProviderIdTaken) }));
    const drawer = await openAddDrawer();
    type(drawer, "Client ID", "client-1");
    type(drawer, "Client secret", "s3cret");
    fireEvent.click(within(drawer).getByRole("button", { name: "Add provider" }));

    expect(await within(drawer).findByText("This provider was added already. Close this and check the list.")).toBeDefined();
  });

  it("shows a failed discovery on the Issuer field", async () => {
    stubApi(handlers([], { [`POST ${path}`]: () => problem(422, problemTypes.ssoDiscoveryFailed) }));
    const drawer = await openAddDrawer();
    fireEvent.click(within(drawer).getByRole("radio", { name: "OpenID Connect" }));
    type(drawer, "Name", "Company");
    type(drawer, "Issuer", "https://login.example.com");
    type(drawer, "Client ID", "files");
    type(drawer, "Client secret", "s3cret");
    fireEvent.click(within(drawer).getByRole("button", { name: "Add provider" }));

    expect(
      await within(drawer).findByText("The provider's settings could not be read from this issuer. Check the address and try again."),
    ).toBeDefined();
  });

  it("saves only the changed fields, leaving out an empty client secret", async () => {
    const fetchMock = stubApi(
      handlers([google], { [`PATCH ${path}/${google.id}`]: () => json(200, { ...google, name: "Google Workspace", enabled: false }) }),
    );
    await openTab();

    await screen.findByRole("table", { name: "Sign-in providers" });
    openMenu("Google");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit provider" });
    expect(within(drawer).getByText("A secret is saved. Leave this empty to keep it.")).toBeDefined();
    expect(within(drawer).queryByRole("radio")).toBeNull();
    type(drawer, "Name", "Google Workspace");
    fireEvent.click(within(drawer).getByRole("switch", { name: "On" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Provider saved")).toBeDefined();
    expect(requestsTo(fetchMock, `PATCH ${path}/${google.id}`).map((request) => request.body)).toEqual([
      { name: "Google Workspace", enabled: false },
    ]);
  });

  it("removes a provider nobody signs in with after a confirmation", async () => {
    const fetchMock = stubApi(handlers([google], { [`DELETE ${path}/${google.id}`]: () => new Response(null, { status: 204 }) }));
    await openTab();

    await screen.findByRole("table", { name: "Sign-in providers" });
    openMenu("Google");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Google?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove provider" }));

    expect(await screen.findByText("Provider removed")).toBeDefined();
    expect(requestsTo(fetchMock, `DELETE ${path}/${google.id}`)).toHaveLength(1);
  });

  it("offers no Remove for a provider with linked sign-ins", async () => {
    stubApi(handlers([company]));
    await openTab();

    await screen.findByRole("table", { name: "Sign-in providers" });
    openMenu("Company");
    const blocked = await screen.findByRole<HTMLButtonElement>("menuitem", { name: "In use: turn it off instead of removing" });
    expect(blocked.disabled).toBe(true);
    expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
  });

  it("asks for the client secret again when the issuer changes", async () => {
    const unused = { ...company, linkedSignIns: 0 };
    const fetchMock = stubApi(handlers([unused]));
    await openTab();

    await screen.findByRole("table", { name: "Sign-in providers" });
    openMenu("Company");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit provider" });
    type(drawer, "Issuer", "https://login.example.org");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save changes" }));

    expect(await within(drawer).findByText("Enter the client secret again: the issuer changed.")).toBeDefined();
    expect(requestsTo(fetchMock, `PATCH ${path}/${unused.id}`)).toEqual([]);
  });

  it("locks the issuer of a provider with linked sign-ins, which match on it", async () => {
    stubApi(handlers([company]));
    await openTab();

    await screen.findByRole("table", { name: "Sign-in providers" });
    openMenu("Company");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit provider" });
    expect(within(drawer).getByLabelText<HTMLInputElement>("Issuer").disabled).toBe(true);
    expect(within(drawer).getByText("Accounts sign in with this provider, so its issuer can't change.")).toBeDefined();
  });

  it("explains a refused removal of a provider in use", async () => {
    stubApi(handlers([google], { [`DELETE ${path}/${google.id}`]: () => problem(409, problemTypes.ssoProviderInUse) }));
    await openTab();

    await screen.findByRole("table", { name: "Sign-in providers" });
    openMenu("Google");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Google?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove provider" }));

    await waitFor(() =>
      expect(within(dialog).getByText("People sign in with this provider, so it can't be removed. Turn it off instead.")).toBeDefined(),
    );
  });
});
