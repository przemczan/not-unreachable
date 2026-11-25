import { problemTypes, type SmtpSettings } from "@not-unreachable/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adminSession, baseHandlers, json, problem, renderApp, requestsTo, stubApi, type MockHandler } from "../testing/index.ts";

const saved: SmtpSettings = {
  host: "smtp.example.com",
  port: 587,
  tlsMode: "starttls",
  username: "files",
  passwordSet: true,
  fromAddress: "files@example.com",
  updatedAt: "2026-11-20T10:00:00.000Z",
};

const path = "/api/v1/admin/mail";

function handlers(smtp: SmtpSettings | null, extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return { ...baseHandlers({ session: adminSession }), [`GET ${path}`]: () => json(200, { smtp }), ...extra };
}

async function openTab(): Promise<void> {
  renderApp("/admin/settings/email");
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  await screen.findByLabelText("Host");
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("Admin settings → Email", () => {
  it("sits between Security and Sign-in providers", async () => {
    stubApi(handlers(null));
    await openTab();

    const tabs = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((tab) => tab.textContent),
    ).toEqual(["Security", "Email", "Sign-in providers", "Limits", "Updates"]);
  });

  it("saves the SMTP settings", async () => {
    const fetchMock = stubApi(handlers(null, { [`PUT ${path}`]: () => json(200, { smtp: saved }) }));
    await openTab();

    type("Host", "smtp.example.com");
    type("Username", "files");
    type("Password", "s3cret");
    type("From address", "files@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Email settings saved")).toBeDefined();
    expect(requestsTo(fetchMock, `PUT ${path}`).map((request) => request.body)).toEqual([
      { host: "smtp.example.com", port: 587, tlsMode: "starttls", username: "files", password: "s3cret", fromAddress: "files@example.com" },
    ]);
  });

  it("keeps the saved password when its field is left blank", async () => {
    const fetchMock = stubApi(handlers(saved, { [`PUT ${path}`]: () => json(200, { smtp: { ...saved, port: 2525 } }) }));
    await openTab();

    expect(screen.getByLabelText<HTMLInputElement>("Password").placeholder).toBe("Saved — leave blank to keep");
    type("Port", "2525");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Email settings saved")).toBeDefined();
    expect(requestsTo(fetchMock, `PUT ${path}`).map((request) => request.body)).toEqual([
      { host: "smtp.example.com", port: 2525, tlsMode: "starttls", username: "files", fromAddress: "files@example.com" },
    ]);
  });

  it("shows a refusal of the server as an Alert", async () => {
    stubApi(
      handlers(saved, {
        [`PUT ${path}`]: () => problem(422, problemTypes.validationFailed, "Invalid", "Security None is allowed only for this computer."),
      }),
    );
    await openTab();

    type("Host", "mail.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Security None is allowed only for this computer.")).toBeDefined();
  });

  it("sends a test email", async () => {
    stubApi(handlers(saved, { [`POST ${path}/test`]: () => json(200, { sentTo: "admin@example.com" }) }));
    await openTab();

    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));

    expect(await screen.findByText("Test email sent to admin@example.com")).toBeDefined();
  });

  it("explains a test email that could not be sent", async () => {
    stubApi(handlers(saved, { [`POST ${path}/test`]: () => problem(502, problemTypes.mailSendFailed) }));
    await openTab();

    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));

    expect(await screen.findByText(/The test email could not be sent/)).toBeDefined();
  });
});
