import {
  problemTypes,
  type Passkey,
  type PasskeyAuthenticationResponse,
  type PasskeyCreationOptions,
  type PasskeyRegistrationResponse,
  type PasskeyRequestOptions,
  type SecondFactor,
  type SecondFactors,
  type Session,
} from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminSession,
  baseHandlers,
  json,
  noContent,
  problem,
  renderApp,
  requestsTo,
  stubApi,
  type MockHandler,
  type MockRequest,
} from "./testing/index.ts";

/** The browser's WebAuthn, as @simplewebauthn/browser wraps it: each test says what it answers. */
const webauthn = vi.hoisted(() => ({
  supported: true,
  startRegistration: vi.fn<(options: { optionsJSON: unknown }) => Promise<unknown>>(),
  startAuthentication: vi.fn<(options: { optionsJSON: unknown }) => Promise<unknown>>(),
}));

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => webauthn.supported,
  startRegistration: webauthn.startRegistration,
  startAuthentication: webauthn.startAuthentication,
}));

beforeEach(() => {
  webauthn.supported = true;
  webauthn.startRegistration.mockReset();
  webauthn.startAuthentication.mockReset();
});

const pendingSession: Session = { ...adminSession, state: "pendingSecondFactor" };

const recoveryCodes = [
  "ABCDE-FGH23",
  "BCDEF-GHI34",
  "CDEFG-HIJ45",
  "DEFGH-IJK56",
  "EFGHI-JKL67",
  "FGHIJ-KLM72",
  "GHIJK-LMN23",
  "HIJKL-MNO34",
  "IJKLM-NOP45",
  "JKLMN-OPQ56",
];

const creationOptions: PasskeyCreationOptions = {
  rp: { id: "localhost", name: "NotUnreachable" },
  user: { id: "dXNlcg", name: "admin", displayName: "Ada Admin" },
  challenge: "Y2hhbGxlbmdl",
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  timeout: 300_000,
  authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  attestation: "none",
};

const requestOptions: PasskeyRequestOptions = {
  challenge: "Y2hhbGxlbmdl",
  rpId: "localhost",
  userVerification: "required",
  timeout: 300_000,
};

const registration: PasskeyRegistrationResponse = {
  id: "Y3JlZGVudGlhbA",
  rawId: "Y3JlZGVudGlhbA",
  type: "public-key",
  clientExtensionResults: { credProps: { rk: true } },
  response: { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0ZXN0", transports: ["internal"] },
};

const assertion: PasskeyAuthenticationResponse = {
  id: "Y3JlZGVudGlhbA",
  rawId: "Y3JlZGVudGlhbA",
  type: "public-key",
  clientExtensionResults: {},
  response: { clientDataJSON: "Y2xpZW50", authenticatorData: "YXV0aA", signature: "c2ln", userHandle: "dXNlcg" },
};

/** What the browser throws when the person closes its passkey prompt, or it times out. */
function cancelled(): Error {
  return Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
}

function locationOf(router: ReturnType<typeof renderApp>["router"]): string {
  return router.state.location.pathname + router.state.location.search;
}

function bodyOf(request: MockRequest): unknown {
  return request.body;
}

function signInHandlers(verify: MockHandler): Record<string, MockHandler> {
  let session: Session | null = null;
  return {
    ...baseHandlers(),
    "GET /api/v1/session": () => (session === null ? problem(401, problemTypes.signInRequired) : json(200, session)),
    "POST /api/v1/sign-in/passkey/options": () => json(200, requestOptions),
    "POST /api/v1/sign-in/passkey/verify": async (request) => {
      const answer = await verify(request);
      if (answer.ok) session = adminSession;
      return answer;
    },
    "GET /api/v1/settings/sessions": () => json(200, { sessions: [] }),
  };
}

describe("signing in with a passkey alone", () => {
  it("lands on a safe ?next= with an active session, the passkey counting as both steps", async () => {
    webauthn.startAuthentication.mockResolvedValue(assertion);
    const fetchMock = stubApi(signInHandlers(() => json(200, adminSession)));
    const { router } = renderApp(`/sign-in?next=${encodeURIComponent("/settings/sessions")}`);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));

    await waitFor(() => expect(locationOf(router)).toBe("/settings/sessions"));
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: requestOptions });
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/passkey/verify").map(bodyOf)).toEqual([{ response: assertion }]);
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in")).toHaveLength(0);
  });

  it("lands the admin in /admin without ?next=", async () => {
    webauthn.startAuthentication.mockResolvedValue(assertion);
    stubApi(signInHandlers(() => json(200, adminSession)));
    const { router } = renderApp("/sign-in");

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeDefined();
    expect(router.state.location.pathname.startsWith("/admin")).toBe(true);
  });

  it("says calmly that a closed prompt was cancelled, and sends nothing to verify", async () => {
    webauthn.startAuthentication.mockRejectedValue(cancelled());
    const fetchMock = stubApi(signInHandlers(() => json(200, adminSession)));
    renderApp("/sign-in");

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));

    const alert = await screen.findByText("The passkey request was cancelled or timed out. Try again when you're ready.");
    expect(alert.closest("[role]")?.getAttribute("role")).toBe("status");
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/passkey/verify")).toHaveLength(0);
  });

  it("says a passkey the server doesn't know can't sign in", async () => {
    webauthn.startAuthentication.mockResolvedValue(assertion);
    stubApi(signInHandlers(() => problem(401, problemTypes.signInFailed)));
    renderApp("/sign-in");

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));

    expect(await screen.findByText("That passkey can't sign you in. Sign in with your password, or use another passkey.")).toBeDefined();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
  });

  it("offers no passkey in a browser that can't use one", async () => {
    webauthn.supported = false;
    stubApi(signInHandlers(() => json(200, adminSession)));
    renderApp("/sign-in");

    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  });
});

/** A pending session that the step's routes make active. */
function stepHandlers(extra: Record<string, MockHandler>): Record<string, MockHandler> {
  let session: Session = pendingSession;
  const activate = () => {
    session = adminSession;
    return json(200, adminSession);
  };
  return {
    ...baseHandlers(),
    "GET /api/v1/session": () => json(200, session),
    "POST /api/v1/sign-in/second-factor/passkey/options": () => json(200, requestOptions),
    "POST /api/v1/sign-in/second-factor/passkey/verify": activate,
    "POST /api/v1/sign-in/second-factor/enrol/totp": () =>
      json(200, { id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d11", setupKey: "JBSWY3DPEHPK3PXP", qrCode: "data:image/svg+xml;base64,PHN2Zy8+" }),
    "POST /api/v1/sign-in/second-factor/enrol/passkey/options": () => json(200, creationOptions),
    "POST /api/v1/sign-in/second-factor/enrol/passkey": () => json(200, { recoveryCodes }),
    "POST /api/v1/sign-in/second-factor/enrol/recovery-codes/acknowledge": activate,
    ...extra,
  };
}

describe("the second-factor step with a passkey", () => {
  it("offers a passkey next to the authenticator app, and passes with it", async () => {
    webauthn.startAuthentication.mockResolvedValue(assertion);
    const fetchMock = stubApi(
      stepHandlers({
        "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "verify", methods: ["totp", "passkey", "recoveryCode"] }),
      }),
    );
    const { router } = renderApp("/sign-in/second-factor");

    // The authenticator app stays first; the passkey is one click away.
    await screen.findByRole("textbox", { name: "Digit 1 of 6" });
    expect(screen.getByRole("button", { name: "Use a recovery code" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Use a passkey" }));
    expect(screen.getByText("Use one of your passkeys to finish signing in.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Use your authenticator app" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Use passkey" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeDefined();
    expect(locationOf(router)).toBe("/admin/audit-log");
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/second-factor/passkey/verify").map(bodyOf)).toEqual([{ response: assertion }]);
  });

  it("opens with the passkey when the account has no authenticator app, and offers no passkey when it has none", async () => {
    stubApi(
      stepHandlers({ "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "verify", methods: ["passkey", "recoveryCode"] }) }),
    );
    const { view } = renderApp("/sign-in/second-factor");
    expect(await screen.findByRole("button", { name: "Use passkey" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Use your authenticator app" })).toBeNull();
    view.unmount();

    stubApi(stepHandlers({ "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "verify", methods: ["totp", "recoveryCode"] }) }));
    renderApp("/sign-in/second-factor");
    await screen.findByRole("textbox", { name: "Digit 1 of 6" });
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
  });

  it("says when the prompt was cancelled, and when the server refused the passkey", async () => {
    webauthn.startAuthentication.mockRejectedValueOnce(cancelled()).mockResolvedValueOnce(assertion);
    stubApi(
      stepHandlers({
        "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "verify", methods: ["passkey", "recoveryCode"] }),
        "POST /api/v1/sign-in/second-factor/passkey/verify": () => problem(401, problemTypes.secondFactorFailed),
      }),
    );
    renderApp("/sign-in/second-factor");

    fireEvent.click(await screen.findByRole("button", { name: "Use passkey" }));
    expect(await screen.findByText("The passkey request was cancelled or timed out. Try again when you're ready.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Use passkey" }));
    expect(await screen.findByText("The passkey was not accepted. Try again, or use another way to sign in.")).toBeDefined();
    expect(screen.queryByText(/cancelled or timed out/)).toBeNull();
  });

  it("says so, and can't start, in a browser without passkeys", async () => {
    webauthn.supported = false;
    stubApi(
      stepHandlers({ "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "verify", methods: ["passkey", "recoveryCode"] }) }),
    );
    renderApp("/sign-in/second-factor");

    expect(await screen.findByText("This browser can't use passkeys. Use another way, or another browser.")).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Use passkey" }).disabled).toBe(true);
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it("adds a passkey instead of an authenticator app at the first sign-in, then shows the recovery codes", async () => {
    webauthn.startRegistration.mockResolvedValue(registration);
    const fetchMock = stubApi(stepHandlers({ "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "enrol", methods: [] }) }));
    const { router } = renderApp("/sign-in/second-factor");

    await screen.findByRole("heading", { level: 1, name: "Set up two-step sign-in" });
    fireEvent.click(await screen.findByRole("button", { name: "Add a passkey instead" }));
    expect(screen.getByText("Add a passkey to your account before you go on.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    expect(await screen.findByText("Enter a name for the passkey.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Passkey name"), { target: { value: "  Laptop  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));

    await screen.findByRole("heading", { level: 1, name: "Save your recovery codes" });
    expect(screen.getByRole("group", { name: "Recovery codes" }).querySelector("code")?.textContent).toBe(recoveryCodes.join("\n"));
    fireEvent.click(screen.getByLabelText("I saved my recovery codes"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeDefined();
    expect(locationOf(router)).toBe("/admin/audit-log");
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: creationOptions });
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/second-factor/enrol/passkey").map(bodyOf)).toEqual([
      { name: "Laptop", response: registration },
    ]);
  });

  it("offers no passkey at enrolment in a browser without passkeys", async () => {
    webauthn.supported = false;
    stubApi(stepHandlers({ "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "enrol", methods: [] }) }));
    renderApp("/sign-in/second-factor");

    await screen.findByRole("img", { name: "QR code for your authenticator app" });
    expect(screen.queryByRole("button", { name: "Add a passkey instead" })).toBeNull();
  });
});

const app: SecondFactor = {
  id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d21",
  kind: "totp",
  createdAt: "2026-11-01T10:00:00.000Z",
  lastUsedAt: null,
};
const phone: Passkey = {
  id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d31",
  name: "Phone",
  synced: true,
  createdAt: "2026-11-02T10:00:00.000Z",
  lastUsedAt: "2026-11-20T10:00:00.000Z",
};
const key: Passkey = { ...phone, id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d32", name: "YubiKey", synced: false, lastUsedAt: null };
const factorOf = (passkey: Passkey): SecondFactor => ({
  id: passkey.id,
  kind: "passkey",
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt,
});

function settingsHandlers(
  passkeys: Passkey[],
  factors: SecondFactor[],
  extra: Record<string, MockHandler> = {},
): Record<string, MockHandler> {
  const state: SecondFactors = { factors, recoveryCodes: { remaining: 10, createdAt: "2026-11-01T10:00:00.000Z" } };
  return {
    ...baseHandlers({ session: adminSession }),
    "GET /api/v1/settings/second-factors": () => json(200, state),
    "GET /api/v1/settings/passkeys": () => json(200, { passkeys }),
    ...extra,
  };
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Your passkeys" }))
    .getByText(name)
    .closest("tr");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
}

async function chooseAction(name: string, action: string): Promise<void> {
  await screen.findByRole("table", { name: "Your passkeys" });
  fireEvent.click(within(rowOf(name)).getByRole("button", { name: `Actions for the passkey ${name}` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

describe("Settings: passkeys", () => {
  it("lists the passkeys, synced ones marked, apart from the authenticator apps", async () => {
    stubApi(settingsHandlers([phone, key], [app, factorOf(phone), factorOf(key)]));
    renderApp("/settings/two-step-sign-in");

    const table = await screen.findByRole("table", { name: "Your passkeys" });
    await within(table).findByText("Phone");
    expect(within(rowOf("Phone")).getByText("Synced")).toBeDefined();
    expect(within(rowOf("YubiKey")).queryByText("Synced")).toBeNull();
    expect(within(rowOf("YubiKey")).getByText("Never")).toBeDefined();
    // Only the authenticator app is in the apps' table, and with other factors it can be removed.
    const apps = screen.getByRole("table", { name: "Your authenticator apps" });
    expect(within(apps).getAllByText("Authenticator app")).toHaveLength(1);
    expect(within(apps).getByRole<HTMLButtonElement>("button", { name: "Remove" }).disabled).toBe(false);
  });

  it("adds a passkey after confirming the recent sign-in, with the name given", async () => {
    let confirmed = false;
    webauthn.startRegistration.mockResolvedValue(registration);
    const fetchMock = stubApi(
      settingsHandlers([], [app], {
        "POST /api/v1/settings/passkeys/registration-options": () =>
          confirmed ? json(200, creationOptions) : problem(403, problemTypes.recentSignInRequired),
        "POST /api/v1/settings/passkeys": () => json(200, { passkey: phone, recoveryCodes: null }),
        "POST /api/v1/session/confirm": () => {
          confirmed = true;
          return json(200, adminSession);
        },
      }),
    );
    renderApp("/settings/two-step-sign-in");
    expect(await screen.findByText("No passkeys")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    const dialog = await screen.findByRole("dialog", { name: "Add passkey" });
    fireEvent.change(within(dialog).getByLabelText("Passkey name"), { target: { value: "Phone" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));

    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.change(within(confirm).getByLabelText("Password"), { target: { value: "secret password" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Passkey added")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add passkey" })).toBeNull());
    expect(requestsTo(fetchMock, "POST /api/v1/settings/passkeys/registration-options")).toHaveLength(2);
    expect(requestsTo(fetchMock, "POST /api/v1/settings/passkeys").map(bodyOf)).toEqual([{ name: "Phone", response: registration }]);
  });

  it("shows the recovery codes when the passkey is the account's first factor", async () => {
    webauthn.startRegistration.mockResolvedValue(registration);
    stubApi(
      settingsHandlers([], [], {
        "POST /api/v1/settings/passkeys/registration-options": () => json(200, creationOptions),
        "POST /api/v1/settings/passkeys": () => json(200, { passkey: phone, recoveryCodes }),
      }),
    );
    renderApp("/settings/two-step-sign-in");
    fireEvent.click(await screen.findByRole("button", { name: "Add passkey" }));
    const dialog = await screen.findByRole("dialog", { name: "Add passkey" });
    fireEvent.change(within(dialog).getByLabelText("Passkey name"), { target: { value: "Phone" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));

    const shown = await screen.findByRole("dialog", { name: "Save your recovery codes" });
    expect(within(shown).getByRole("group", { name: "Recovery codes" }).querySelector("code")?.textContent).toBe(recoveryCodes.join("\n"));
    fireEvent.click(within(shown).getByLabelText("I saved my recovery codes"));
    fireEvent.click(within(shown).getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Passkey added")).toBeDefined();
  });

  it("keeps the dialog open with a calm Alert when the prompt is cancelled", async () => {
    webauthn.startRegistration.mockRejectedValue(cancelled());
    const fetchMock = stubApi(
      settingsHandlers([], [app], { "POST /api/v1/settings/passkeys/registration-options": () => json(200, creationOptions) }),
    );
    renderApp("/settings/two-step-sign-in");
    fireEvent.click(await screen.findByRole("button", { name: "Add passkey" }));
    const dialog = await screen.findByRole("dialog", { name: "Add passkey" });
    fireEvent.change(within(dialog).getByLabelText("Passkey name"), { target: { value: "Phone" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));

    expect(await within(dialog).findByText("The passkey request was cancelled or timed out. Try again when you're ready.")).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/settings/passkeys")).toHaveLength(0);
  });

  it("renames a passkey", async () => {
    const fetchMock = stubApi(
      settingsHandlers([phone, key], [factorOf(phone), factorOf(key)], {
        [`PATCH /api/v1/settings/passkeys/${phone.id}`]: () => json(200, { ...phone, name: "Work phone" }),
      }),
    );
    renderApp("/settings/two-step-sign-in");
    await screen.findByText("Phone");
    await chooseAction("Phone", "Rename");

    const dialog = await screen.findByRole("dialog", { name: "Rename passkey" });
    const field = within(dialog).getByLabelText<HTMLInputElement>("Passkey name");
    expect(field.value).toBe("Phone");
    fireEvent.change(field, { target: { value: "Work phone" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename passkey" }));

    expect(await screen.findByText("Passkey renamed")).toBeDefined();
    expect(requestsTo(fetchMock, `PATCH /api/v1/settings/passkeys/${phone.id}`).map(bodyOf)).toEqual([{ name: "Work phone" }]);
  });

  it("removes a passkey, and shows the server's refusal for the last factor", async () => {
    const fetchMock = stubApi(
      settingsHandlers([phone, key], [factorOf(phone), factorOf(key)], {
        [`DELETE /api/v1/settings/passkeys/${phone.id}`]: () => noContent(),
        [`DELETE /api/v1/settings/passkeys/${key.id}`]: () => problem(409, problemTypes.lastSecondFactor),
      }),
    );
    renderApp("/settings/two-step-sign-in");
    await screen.findByText("Phone");

    await chooseAction("Phone", "Remove");
    let dialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove passkey" }));
    expect(await screen.findByText("Passkey removed")).toBeDefined();

    await chooseAction("YubiKey", "Remove");
    dialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove passkey" }));
    expect(await screen.findByText("Your last passkey can't be removed. Add another passkey or an authenticator app first.")).toBeDefined();
    expect(requestsTo(fetchMock, `DELETE /api/v1/settings/passkeys/${key.id}`)).toHaveLength(1);
  });

  it("can't remove the account's only factor", async () => {
    stubApi(settingsHandlers([phone], [factorOf(phone)]));
    renderApp("/settings/two-step-sign-in");
    await screen.findByText("Phone");
    expect(screen.getByText("Your last passkey can't be removed. Add another passkey or an authenticator app first.")).toBeDefined();

    fireEvent.click(within(rowOf("Phone")).getByRole("button", { name: "Actions for the passkey Phone" }));
    const remove = await screen.findByRole<HTMLButtonElement>("menuitem", { name: "Remove" });
    expect(remove.disabled).toBe(true);
  });

  it("says a browser without passkeys can't add one", async () => {
    webauthn.supported = false;
    stubApi(settingsHandlers([phone], [app, factorOf(phone)]));
    renderApp("/settings/two-step-sign-in");

    expect(await screen.findByText("This browser can't use passkeys. Use another way, or another browser.")).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add passkey" }).disabled).toBe(true);
  });
});

describe("recent sign-in with a passkey", () => {
  it("offers the passkey when the account has one, and confirms with it", async () => {
    let confirmed = false;
    webauthn.startAuthentication.mockResolvedValue(assertion);
    const fetchMock = stubApi(
      settingsHandlers([phone], [app, factorOf(phone)], {
        "POST /api/v1/settings/second-factors/recovery-codes": () =>
          confirmed ? json(200, { recoveryCodes }) : problem(403, problemTypes.recentSignInRequired),
        "POST /api/v1/session/confirm/passkey-options": () => json(200, requestOptions),
        "POST /api/v1/session/confirm": () => {
          confirmed = true;
          return json(200, adminSession);
        },
      }),
    );
    renderApp("/settings/two-step-sign-in");
    await screen.findByText("10 / 10 left");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Regenerate recovery codes?" })).getByRole("button", { name: "Regenerate codes" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.click(await within(dialog).findByRole("radio", { name: "Passkey" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("dialog", { name: "Save your new recovery codes" })).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/session/confirm").map(bodyOf)).toEqual([{ passkey: assertion }]);
  });
});
