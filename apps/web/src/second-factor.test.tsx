import { problemTypes, type SecondFactor, type SecondFactors, type Session } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

const enrolment = {
  id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d11",
  setupKey: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  qrCode: "data:image/svg+xml;base64,PHN2Zy8+",
};

function locationOf(router: ReturnType<typeof renderApp>["router"]): string {
  return router.state.location.pathname + router.state.location.search;
}

function enterCode(code: string, container: HTMLElement = document.body): void {
  fireEvent.change(within(container).getByRole("textbox", { name: "Digit 1 of 6" }), { target: { value: code } });
}

function bodyOf(request: MockRequest): unknown {
  return request.body;
}

/** The `code` of a request's body. */
function codeOf(request: MockRequest): unknown {
  const { body } = request;
  return typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
}

/** A session that the step's routes move along: signed out, pending after the password, then active. */
function stepHandlers(start: Session | null, extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  let session = start;
  const activate = () => {
    session = adminSession;
    return json(200, adminSession);
  };
  return {
    ...baseHandlers(),
    "GET /api/v1/session": () => (session === null ? problem(401, problemTypes.signInRequired) : json(200, session)),
    "POST /api/v1/sign-in": () => {
      session = pendingSession;
      return json(200, pendingSession);
    },
    "POST /api/v1/sign-out": () => {
      session = null;
      return noContent();
    },
    "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "verify", methods: ["totp", "recoveryCode"] }),
    "POST /api/v1/sign-in/second-factor/totp": (request) =>
      codeOf(request) === "123456" ? activate() : problem(401, problemTypes.secondFactorFailed),
    "POST /api/v1/sign-in/second-factor/recovery-code": (request) =>
      codeOf(request) === "ABCDE-FGH23" ? activate() : problem(401, problemTypes.secondFactorFailed),
    "POST /api/v1/sign-in/second-factor/enrol/totp": () => json(200, enrolment),
    "POST /api/v1/sign-in/second-factor/enrol/totp/confirm": (request) =>
      codeOf(request) === "123456" ? json(200, { recoveryCodes }) : problem(401, problemTypes.secondFactorFailed),
    "POST /api/v1/sign-in/second-factor/enrol/recovery-codes/acknowledge": activate,
    ...extra,
  };
}

describe("second-factor step", () => {
  it("follows the password with the authenticator code, refuses a wrong one and lands on ?next=", async () => {
    const fetchMock = stubApi({ ...stepHandlers(null), "GET /api/v1/settings/sessions": () => json(200, { sessions: [] }) });
    const { router } = renderApp(`/sign-in?next=${encodeURIComponent("/settings/sessions")}`);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });

    fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "ada" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("heading", { level: 1, name: "Two-step sign-in" });
    expect(locationOf(router)).toBe(`/sign-in/second-factor?next=${encodeURIComponent("/settings/sessions")}`);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Digit 1 of 6" })));

    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Enter the 6-digit code from your authenticator app.")).toBeDefined();

    enterCode("000000");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("The code is not right. Check the code in your app and try again.")).toBeDefined();

    enterCode("123 456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(locationOf(router)).toBe("/settings/sessions"));
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/second-factor/totp").map(bodyOf)).toEqual([{ code: "000000" }, { code: "123456" }]);
  });

  it("takes a recovery code instead", async () => {
    const fetchMock = stubApi(stepHandlers(pendingSession));
    const { router } = renderApp("/sign-in/second-factor");
    fireEvent.click(await screen.findByRole("button", { name: "Use a recovery code" }));
    const field = screen.getByLabelText("Recovery code");
    fireEvent.change(field, { target: { value: "ZZZZZ-ZZZZZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("The recovery code is not right, or it was used already.")).toBeDefined();

    fireEvent.change(field, { target: { value: " ABCDE-FGH23 " } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeDefined();
    expect(locationOf(router)).toBe("/admin/audit-log");
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/second-factor/recovery-code").map(bodyOf)).toEqual([
      { code: "ZZZZZ-ZZZZZ" },
      { code: "ABCDE-FGH23" },
    ]);
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/second-factor/totp")).toHaveLength(0);
  });

  it("adds the first authenticator app, shows the recovery codes once and goes on once they are saved", async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:codes");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn<(url: string) => void>() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const fetchMock = stubApi(
      stepHandlers(pendingSession, { "GET /api/v1/sign-in/second-factor": () => json(200, { mode: "enrol", methods: [] }) }),
    );
    const { router } = renderApp("/sign-in/second-factor");

    await screen.findByRole("heading", { level: 1, name: "Set up two-step sign-in" });
    expect((await screen.findByRole("img", { name: "QR code for your authenticator app" })).getAttribute("src")).toBe(enrolment.qrCode);
    expect(screen.getByRole("group", { name: "Setup key" }).querySelector("code")?.textContent).toBe(enrolment.setupKey);

    enterCode("000000");
    fireEvent.click(screen.getByRole("button", { name: "Add authenticator app" }));
    expect(await screen.findByText("The code is not right. Check the code in your app and try again.")).toBeDefined();
    enterCode("123456");
    fireEvent.click(screen.getByRole("button", { name: "Add authenticator app" }));

    await screen.findByRole("heading", { level: 1, name: "Save your recovery codes" });
    expect(screen.getByRole("group", { name: "Recovery codes" }).querySelector("code")?.textContent).toBe(recoveryCodes.join("\n"));
    fireEvent.click(screen.getByRole("button", { name: "Download codes" }));
    expect(click).toHaveBeenCalledOnce();
    const file = createObjectURL.mock.calls[0]?.[0];
    expect(await file?.text()).toContain(recoveryCodes.join("\n"));

    const proceed = screen.getByRole<HTMLButtonElement>("button", { name: "Continue" });
    expect(proceed.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I saved my recovery codes"));
    expect(proceed.disabled).toBe(false);
    fireEvent.click(proceed);

    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeDefined();
    expect(locationOf(router)).toBe("/admin/audit-log");
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/second-factor/enrol/totp")).toHaveLength(1);
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/second-factor/enrol/totp/confirm").map(bodyOf)).toEqual([
      { id: enrolment.id, code: "000000" },
      { id: enrolment.id, code: "123456" },
    ]);
    expect(requestsTo(fetchMock, "POST /api/v1/sign-in/second-factor/enrol/recovery-codes/acknowledge")).toHaveLength(1);
  });

  it.each([
    [429, problemTypes.tooManyAttempts, "Too many wrong codes. Sign in again."],
    [401, problemTypes.signInRequired, "The sign-in took too long. Sign in again."],
  ])("goes back to the password on %i %s, saying why", async (status, type, message) => {
    stubApi(stepHandlers(pendingSession, { "POST /api/v1/sign-in/second-factor/totp": () => problem(status, type) }));
    const { router } = renderApp("/sign-in/second-factor");
    await screen.findByRole("textbox", { name: "Digit 1 of 6" });

    enterCode("123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText(message)).toBeDefined();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
    expect(locationOf(router)).toBe("/sign-in");
  });

  it("starts again by signing the pending session out", async () => {
    const fetchMock = stubApi(stepHandlers(pendingSession));
    const { router } = renderApp("/sign-in/second-factor");
    fireEvent.click(await screen.findByRole("button", { name: "Start again" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
    expect(locationOf(router)).toBe("/sign-in");
    expect(requestsTo(fetchMock, "POST /api/v1/sign-out")).toHaveLength(1);
  });

  it.each(["/", "/sign-in", "/admin/resources", "/settings/profile"])("keeps a pending session on the step from %s", async (path) => {
    stubApi(stepHandlers(pendingSession));
    const { router } = renderApp(path);

    await screen.findByRole("heading", { level: 1, name: "Two-step sign-in" });
    expect(router.state.location.pathname).toBe("/sign-in/second-factor");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("carries the page asked for on to the step", async () => {
    stubApi(stepHandlers(pendingSession));
    const { router } = renderApp("/admin/resources");
    await screen.findByRole("heading", { level: 1, name: "Two-step sign-in" });
    expect(locationOf(router)).toBe(`/sign-in/second-factor?next=${encodeURIComponent("/admin/resources")}`);
  });
});

const firstFactor: SecondFactor = {
  id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d21",
  kind: "totp",
  createdAt: "2026-11-01T10:00:00.000Z",
  lastUsedAt: "2026-11-20T10:00:00.000Z",
};
const secondFactor: SecondFactor = { ...firstFactor, id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d22", lastUsedAt: null };

function settingsHandlers(factors: SecondFactor[], extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  const state: SecondFactors = { factors, recoveryCodes: { remaining: 7, createdAt: "2026-11-01T10:00:00.000Z" } };
  return {
    ...baseHandlers({ session: adminSession }),
    "GET /api/v1/settings/second-factors": () => json(200, state),
    ...extra,
  };
}

describe("Settings: Two-step sign-in", () => {
  it("is a tab of the admin's account settings, listing the apps and the recovery codes left", async () => {
    stubApi(settingsHandlers([firstFactor]));
    renderApp("/settings/profile");
    const tabs = await screen.findByRole("navigation", { name: "Account settings sections" });
    fireEvent.click(within(tabs).getByRole("link", { name: "Two-step sign-in" }));

    const table = await screen.findByRole("table", { name: "Your authenticator apps" });
    expect(within(table).getByText("Authenticator app")).toBeDefined();
    expect(screen.getByText("7 / 10 left")).toBeDefined();
  });

  it("can't remove the last app, says why, and shows the server's refusal too", async () => {
    stubApi(settingsHandlers([firstFactor]));
    const { view } = renderApp("/settings/two-step-sign-in");
    const table = await screen.findByRole("table", { name: "Your authenticator apps" });
    expect(within(table).getByRole<HTMLButtonElement>("button", { name: "Remove" }).disabled).toBe(true);
    expect(screen.getByText("Your last authenticator app can't be removed. Add another one first.")).toBeDefined();
    view.unmount();

    // Two apps on screen, but the other one went meanwhile (another tab): the server refuses.
    const fetchMock = stubApi(
      settingsHandlers([firstFactor, secondFactor], {
        "DELETE /api/v1/settings/second-factors/totp/0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d21": () =>
          problem(409, problemTypes.lastSecondFactor),
      }),
    );
    renderApp("/settings/two-step-sign-in");
    const [removeFirst] = within(await screen.findByRole("table", { name: "Your authenticator apps" })).getAllByRole("button", {
      name: "Remove",
    });
    if (removeFirst === undefined) throw new Error("No Remove button.");
    fireEvent.click(removeFirst);
    const dialog = await screen.findByRole("dialog", { name: "Remove this authenticator app?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove app" }));

    expect(await screen.findByText("Your last authenticator app can't be removed. Add another one first.")).toBeDefined();
    expect(requestsTo(fetchMock, `DELETE /api/v1/settings/second-factors/totp/${firstFactor.id}`)).toHaveLength(1);
  });

  it("adds another authenticator app with its QR code and a code", async () => {
    const fetchMock = stubApi(
      settingsHandlers([firstFactor], {
        "POST /api/v1/settings/second-factors/totp": () => json(200, enrolment),
        [`POST /api/v1/settings/second-factors/totp/${enrolment.id}/confirm`]: (request) =>
          codeOf(request) === "123456" ? json(200, { ...secondFactor, id: enrolment.id }) : problem(422, problemTypes.secondFactorFailed),
      }),
    );
    renderApp("/settings/two-step-sign-in");
    await screen.findByRole("table", { name: "Your authenticator apps" });

    fireEvent.click(screen.getByRole("button", { name: "Add authenticator app" }));
    const dialog = await screen.findByRole("dialog", { name: "Add authenticator app" });
    expect(within(dialog).getByRole("img", { name: "QR code for your authenticator app" })).toBeDefined();
    enterCode("000000", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add app" }));
    expect(await within(dialog).findByText(/The code is not right, or the setup took too long/)).toBeDefined();
    enterCode("123456", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add app" }));

    expect(await screen.findByText("Authenticator app added")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add authenticator app" })).toBeNull());
    expect(requestsTo(fetchMock, `POST /api/v1/settings/second-factors/totp/${enrolment.id}/confirm`).map(bodyOf)).toEqual([
      { code: "000000" },
      { code: "123456" },
    ]);
  });

  it("regenerates the recovery codes after a confirm, and shows the new ones once", async () => {
    const fetchMock = stubApi(
      settingsHandlers([firstFactor], { "POST /api/v1/settings/second-factors/recovery-codes": () => json(200, { recoveryCodes }) }),
    );
    renderApp("/settings/two-step-sign-in");
    await screen.findByText("7 / 10 left");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));
    const confirm = await screen.findByRole("dialog", { name: "Regenerate recovery codes?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Regenerate codes" }));

    const shown = await screen.findByRole("dialog", { name: "Save your new recovery codes" });
    expect(within(shown).getByRole("group", { name: "Recovery codes" }).querySelector("code")?.textContent).toBe(recoveryCodes.join("\n"));
    const done = within(shown).getByRole<HTMLButtonElement>("button", { name: "Done" });
    expect(done.disabled).toBe(true);
    fireEvent.click(within(shown).getByLabelText("I saved my recovery codes"));
    fireEvent.click(done);

    expect(await screen.findByText("Recovery codes regenerated")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save your new recovery codes" })).toBeNull());
    expect(requestsTo(fetchMock, "POST /api/v1/settings/second-factors/recovery-codes")).toHaveLength(1);
  });
});

describe("recent sign-in with an authenticator code", () => {
  it("confirms with a code instead of the password, then runs the action again", async () => {
    let confirmed = false;
    const fetchMock = stubApi(
      settingsHandlers([firstFactor], {
        "POST /api/v1/settings/second-factors/recovery-codes": () =>
          confirmed ? json(200, { recoveryCodes }) : problem(403, problemTypes.recentSignInRequired),
        "POST /api/v1/session/confirm": (request) => {
          if (codeOf(request) !== "123456") return problem(401, problemTypes.secondFactorFailed);
          confirmed = true;
          return json(200, adminSession);
        },
      }),
    );
    renderApp("/settings/two-step-sign-in");
    await screen.findByText("7 / 10 left");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Regenerate recovery codes?" })).getByRole("button", { name: "Regenerate codes" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Authenticator code" }));
    enterCode("000000", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByText("The code is not right. Check the code in your app and try again.")).toBeDefined();
    enterCode("123456", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("dialog", { name: "Save your new recovery codes" })).toBeDefined();
    expect(requestsTo(fetchMock, "POST /api/v1/session/confirm").map(bodyOf)).toEqual([{ code: "000000" }, { code: "123456" }]);
    expect(requestsTo(fetchMock, "POST /api/v1/settings/second-factors/recovery-codes")).toHaveLength(2);
  });
});
