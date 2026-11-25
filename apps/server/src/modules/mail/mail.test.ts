import { problemTypes, routes, type MailSettings, type RecoveryCodes, type UpdateMailSettingsRequest } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECENT_SIGN_IN_MS } from "../../http/index.ts";
import { buildTestApp, expectProblem, startFakeSmtp, testSecrets, type FakeSmtp, type TestApp } from "../../test-support/index.ts";
import { callRoute, tableRows } from "../../test-support/sessions.ts";
import { envelopeColumns, createSecrets, rotateMasterKey } from "../platform/index.ts";
import { isLoopbackHost, smtpPasswordAad } from "./service.ts";
import { renderMail } from "./templates.ts";

const PASSWORD = "hunter2-smtp-password";
const origin = "https://files.example.com";

describe("loopback hosts", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.255.0.9", "::1", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });
  it.each(["mail.example.com", "10.0.0.1", "128.0.0.1", "127.0.0.1.example.com", "::2", "0.0.0.0"])("%s is not", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

const link = (path: string) => `${origin}${path}`;

describe("email templates", () => {
  it("builds the invitation with an absolute link in the text and the HTML", () => {
    const mail = renderMail({ kind: "invitation", token: "tok_en-1", expiresAt: "2026-12-01T10:30:00.000Z" }, origin);
    expect(mail.subject).toContain("NotUnreachable");
    expect(mail.text).toContain(link("/invitation/tok_en-1"));
    expect(mail.text).toContain("2026-12-01 10:30 UTC");
    expect(mail.html).toContain(`href="${link("/invitation/tok_en-1")}"`);
  });

  it("builds the relink mail and escapes every value in the HTML", () => {
    const mail = renderMail({ kind: "relink", token: "a&b", expiresAt: "2026-12-01T10:30:00.000Z", username: '<b>"x"</b>' }, origin);
    expect(mail.text).toContain(link("/relink/a%26b"));
    expect(mail.html).toContain(`href="${link("/relink/a%26b")}"`);
    expect(mail.html).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>");
  });

  it("escapes a security notice", () => {
    const mail = renderMail({ kind: "security-notice", subject: "<i>hi</i>", text: "a & b" }, origin);
    expect(mail.html).toContain("&lt;i&gt;hi&lt;/i&gt;");
    expect(mail.html).toContain("a &amp; b");
    expect(mail.text).toContain("a & b");
  });
});

describe("the mail routes", () => {
  let test: TestApp;
  let smtp: FakeSmtp;
  let cookie: string;

  beforeEach(async () => {
    test = await buildTestApp();
    smtp = await startFakeSmtp();
    cookie = await test.signIn((await test.createAdmin({ email: "admin@example.com" })).username);
  });
  afterEach(async () => {
    await smtp.close();
    await test.close();
  });

  const settings = (overrides: Partial<UpdateMailSettingsRequest> = {}): UpdateMailSettingsRequest => ({
    host: "127.0.0.1",
    port: smtp.port,
    tlsMode: "none",
    username: null,
    fromAddress: "noreply@example.com",
    ...overrides,
  });
  const put = (payload: UpdateMailSettingsRequest, as = cookie) => callRoute(test, routes.updateMailSettings, { cookie: as, payload });
  const read = async (): Promise<MailSettings> => (await callRoute(test, routes.getMailSettings, { cookie })).json();
  const storedPassword = (): unknown => tableRows(test, "mail_settings")[0]?.["password"];

  it("starts with no SMTP settings", async () => {
    expect(await read()).toEqual({ smtp: null });
    expect(test.services.mail.isConfigured()).toBe(false);
  });

  const sendTest = () => callRoute(test, routes.sendTestEmail, { cookie });

  /** Signs in again with one of the account's fresh recovery codes. */
  const useRecoveryCode = async (): Promise<void> => {
    const { recoveryCodes } = (await callRoute(test, routes.regenerateRecoveryCodes, { cookie })).json<RecoveryCodes>();
    const pending = await test.signInWithPassword("admin");
    const code = recoveryCodes[0] ?? "";
    expect((await callRoute(test, routes.passRecoveryCode, { cookie: pending.cookie, payload: { code } })).statusCode).toBe(200);
  };

  describe("the TLS rule (threat model, T6)", () => {
    it("refuses no TLS for a host that isn't loopback", async () => {
      expectProblem(await put(settings({ host: "mail.example.com" })), 422, problemTypes.validationFailed);
      expect(await read()).toEqual({ smtp: null });
    });

    it.each(["127.0.0.1", "localhost", "::1"])("allows no TLS for %s", async (host) => {
      expect((await put(settings({ host }))).statusCode).toBe(200);
    });

    it.each(["starttls", "tls"] as const)("allows %s for any host", async (tlsMode) => {
      expect((await put(settings({ host: "mail.example.com", port: 587, tlsMode }))).statusCode).toBe(200);
    });
  });

  describe("the password", () => {
    it("is kept as an envelope, never answered, and kept when left out", async () => {
      const response = await put(settings({ username: "mailer", password: PASSWORD }));
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(PASSWORD);
      expect(response.json()).toMatchObject({ smtp: { username: "mailer", passwordSet: true } });

      const stored = String(storedPassword());
      expect(stored).not.toContain(PASSWORD);
      expect(testSecrets.decrypt("smtp", smtpPasswordAad, stored)).toBe(PASSWORD);

      const again = await put(settings({ username: "mailer", fromAddress: "other@example.com" }));
      expect(again.json()).toMatchObject({ smtp: { passwordSet: true, fromAddress: "other@example.com" } });
      expect(testSecrets.decrypt("smtp", smtpPasswordAad, String(storedPassword()))).toBe(PASSWORD);
      expect((await callRoute(test, routes.getMailSettings, { cookie })).body).not.toContain(PASSWORD);
    });

    it("is never sent to another server: changing the host needs it typed again", async () => {
      await put(settings({ username: "mailer", password: PASSWORD }));
      const moved = await put(settings({ host: "localhost", username: "mailer" }));
      expectProblem(moved, 400, problemTypes.badRequest);
      expect(moved.body).toContain("Enter the password again");
      expect((await read()).smtp).toMatchObject({ host: "127.0.0.1", passwordSet: true });

      expect((await put(settings({ host: "localhost", username: "mailer", password: "a new one" }))).statusCode).toBe(200);
      expect(testSecrets.decrypt("smtp", smtpPasswordAad, String(storedPassword()))).toBe("a new one");
      // Another port of the same host keeps it.
      expect((await put(settings({ host: "localhost", port: smtp.port + 1, username: "mailer" }))).statusCode).toBe(200);
    });

    it("is dropped with the username", async () => {
      await put(settings({ username: "mailer", password: PASSWORD }));
      expect((await put(settings())).json()).toMatchObject({ smtp: { username: null, passwordSet: false } });
      expect(storedPassword()).toBeNull();
    });

    it("is re-encrypted by rotate-key", async () => {
      await put(settings({ username: "mailer", password: PASSWORD }));
      const newKey = Buffer.alloc(32, 9);
      const rotated = rotateMasterKey({ database: test.database, oldKey: Buffer.alloc(32, 7), newKey, columns: envelopeColumns });
      expect(rotated).toContainEqual({ table: "mail_settings", column: "password", reencrypted: 1 });
      expect(createSecrets(newKey).decrypt("smtp", smtpPasswordAad, String(storedPassword()))).toBe(PASSWORD);
    });
  });

  it("records settings.changed with the changed fields and never the password", async () => {
    await put(settings({ username: "mailer", password: PASSWORD }));
    await put(settings({ username: "mailer", fromAddress: "other@example.com" }));
    await put(settings({ username: "mailer", fromAddress: "other@example.com" }));

    const events = test.audited("settings.changed");
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.details)).toContainEqual({ setting: "mail", fields: ["fromAddress"] });
    expect(events.map((event) => event.details)).toContainEqual({
      setting: "mail",
      fields: ["host", "port", "tlsMode", "username", "password", "fromAddress"],
    });
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(events[0]).toMatchObject({ actorUsername: "admin", outcome: "succeeded" });
  });

  it("needs a recent sign-in and the admin role to change the settings", async () => {
    const user = test.createUser();
    expectProblem(await put(settings(), test.startSession(user)), 403, problemTypes.forbidden);
    test.clock.advance(RECENT_SIGN_IN_MS);
    expectProblem(await put(settings()), 403, problemTypes.recentSignInRequired);
    expect(test.audited("settings.changed")).toEqual([]);
  });

  describe("the test email", () => {
    it("is refused before SMTP is set up", async () => {
      expectProblem(await sendTest(), 409, problemTypes.smtpNotConfigured);
      expect(test.audited("mail.test-sent")).toEqual([]);
    });

    it("arrives at the admin's address and is recorded", async () => {
      await put(settings());
      const response = await sendTest();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ sentTo: "admin@example.com" });
      expect(smtp.received).toHaveLength(1);
      expect(smtp.received[0]).toMatchObject({ from: "noreply@example.com", to: ["admin@example.com"] });
      expect(smtp.received[0]?.raw).toContain("NotUnreachable");
      expect(test.audited("mail.test-sent")).toMatchObject([{ outcome: "succeeded", actorUsername: "admin" }]);
    });

    it("answers 502 when the server can't be reached, and records the failure", async () => {
      await put(settings());
      await smtp.close();
      const problem = expectProblem(await sendTest(), 502, problemTypes.mailSendFailed);
      expect(JSON.stringify(problem)).not.toContain(String(smtp.port));
      expect(test.audited("mail.test-sent")).toMatchObject([{ outcome: "failed" }]);
    });

    it("never goes on without TLS in starttls mode", async () => {
      await put(settings({ tlsMode: "starttls" }));
      expectProblem(await sendTest(), 502, problemTypes.mailSendFailed);
      expect(smtp.received).toEqual([]);
    });

    it("does not log the password when a send fails", async () => {
      await put(settings({ username: "mailer", password: PASSWORD }));
      await smtp.close();
      await sendTest();
      expect(JSON.stringify(test.logs())).not.toContain(PASSWORD);
    });
  });

  describe("security notices", () => {
    it("are emailed to the account holder once SMTP is set up", async () => {
      await put(settings());
      await useRecoveryCode();
      await vi.waitFor(() => expect(smtp.received).toHaveLength(1));
      expect(smtp.received[0]).toMatchObject({ to: ["admin@example.com"] });
      expect(smtp.received[0]?.raw).toContain("A recovery code was used - 9 left");
    });

    it("are only audited before SMTP is set up", async () => {
      await useRecoveryCode();
      expect(test.audited("second-factor.recovery-code-used")).toHaveLength(1);
      expect(smtp.received).toEqual([]);
    });

    it("never fail the action when the mail can't be sent", async () => {
      await put(settings());
      await smtp.close();
      await useRecoveryCode();
      await vi.waitFor(() => expect(test.logs().some((line) => line["msg"] === "a security notice could not be emailed")).toBe(true));
    });
  });
});
