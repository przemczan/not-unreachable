import { problemTypes, type Invitation, type User } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
} from "../testing/index.ts";

const una: User = {
  id: "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01",
  username: "una",
  email: "una@example.com",
  displayName: "Una User",
  status: "active",
  quotaBytes: null,
  linkedSignIns: [
    {
      id: "8b2f3c4d-5e6f-4a70-9b8c-0d1e2f3a4b01",
      providerId: "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a01",
      providerName: "Google",
      providerKind: "google",
      email: "una@example.com",
      createdAt: "2026-11-20T10:00:00.000Z",
      lastUsedAt: null,
    },
  ],
  createdAt: "2026-11-20T10:00:00.000Z",
  disabledAt: null,
};

const pending: Invitation = {
  id: "6d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e501",
  email: "new@example.com",
  sendByEmail: true,
  verifyEmail: true,
  state: "pending",
  createdAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2026-11-27T10:00:00.000Z",
  acceptedAt: null,
  acceptedUsername: null,
  revokedAt: null,
};

const smtp = {
  host: "smtp.example.com",
  port: 587,
  tlsMode: "starttls",
  username: null,
  passwordSet: false,
  fromAddress: "files@example.com",
  updatedAt: "2026-11-20T10:00:00.000Z",
};
const mailPath = "/api/v1/admin/mail";

const link = "https://files.example.com/invitation/k3xV9q2Lr8bN0mWc5tYh1pZa7sDf4gJe6uIo2nBv3Qw";
const usersPath = "/api/v1/admin/users";
const invitationsPath = "/api/v1/admin/invitations";

function handlers(users: User[], invitations: Invitation[], extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    ...baseHandlers({ session: adminSession }),
    [`GET ${usersPath}`]: () => json(200, { users, defaultQuotaBytes: 10_000_000_000 }),
    [`GET ${invitationsPath}`]: () => json(200, { invitations }),
    ...extra,
  };
}

async function openPage(path: string): Promise<void> {
  renderApp(path);
  await screen.findByRole("heading", { level: 1, name: "Users" });
}

function rowOf(table: string, text: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: table }))
    .getByText(text)
    .closest("tr");
  if (row == null) throw new Error(`No row for ${text}`);
  return row;
}

async function chooseAction(table: string, text: string, menuLabel: string, action: string): Promise<void> {
  await screen.findByRole("table", { name: table });
  fireEvent.click(within(rowOf(table, text)).getByRole("button", { name: menuLabel }));
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

describe("Admin → Users", () => {
  it("lists users with their status, linked sign-ins and quota", async () => {
    stubApi(
      handlers(
        [
          una,
          {
            ...una,
            id: "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02",
            username: "ola",
            displayName: "Ola",
            status: "disabled",
            quotaBytes: 2_500_000_000,
          },
        ],
        [],
      ),
    );
    await openPage("/admin/users");

    await screen.findByRole("table", { name: "Users" });
    expect(within(rowOf("Users", "Una User")).getByText("Active")).toBeDefined();
    expect(within(rowOf("Users", "Una User")).getByText("Default (10 GB)")).toBeDefined();
    expect(within(rowOf("Users", "Una User")).getByText("Google")).toBeDefined();
    expect(within(rowOf("Users", "Ola")).getByText("Disabled")).toBeDefined();
    expect(within(rowOf("Users", "Ola")).getByText("2.5 GB")).toBeDefined();
  });

  it("offers to invite someone while there are no users", async () => {
    stubApi(handlers([], []));
    await openPage("/admin/users");

    expect(await screen.findByText("No users yet")).toBeDefined();
    const table = screen.getByRole("table", { name: "Users" });
    fireEvent.click(within(table).getByRole("button", { name: "Invite user" }));
    expect(await screen.findByRole("dialog", { name: "Invite user" })).toBeDefined();
  });

  it("disables a user after a confirmation", async () => {
    const fetchMock = stubApi(
      handlers([una], [], { [`PATCH ${usersPath}/${una.id}`]: () => json(200, { ...una, status: "disabled", disabledAt: una.createdAt }) }),
    );
    await openPage("/admin/users");

    await chooseAction("Users", "Una User", "Actions for Una User", "Disable");
    const dialog = await screen.findByRole("dialog", { name: "Disable Una User?" });
    expect(within(dialog).getByText(/every session they have ends now/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable user" }));

    expect(await screen.findByText("User disabled")).toBeDefined();
    expect(requestsTo(fetchMock, `PATCH ${usersPath}/${una.id}`).map((request) => request.body)).toEqual([{ status: "disabled" }]);
  });

  it("removes a user, keeping their files unless told otherwise, once the username is typed", async () => {
    const fetchMock = stubApi(handlers([una], [], { [`DELETE ${usersPath}/${una.id}`]: () => noContent() }));
    await openPage("/admin/users");

    await chooseAction("Users", "Una User", "Actions for Una User", "Remove");
    const dialog = await screen.findByRole("dialog", { name: "Remove Una User?" });
    expect(within(dialog).getByRole<HTMLInputElement>("radio", { name: /Keep files/ }).checked).toBe(true);
    const remove = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Remove user" });
    expect(remove.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type una to confirm"), { target: { value: "una" } });
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);

    expect(await screen.findByText("User removed")).toBeDefined();
    expect(requestsTo(fetchMock, `DELETE ${usersPath}/${una.id}`).map((request) => request.body)).toEqual([{ homeFolder: "keep" }]);
  });

  it("creates a re-link link and shows it to copy", async () => {
    const relink = "https://files.example.com/relink/k3xV9q2Lr8bN0mWc5tYh1pZa7sDf4gJe6uIo2nBv3Qw";
    stubApi(
      handlers([una], [], {
        [`POST ${usersPath}/${una.id}/relink-links`]: () =>
          json(201, { link: relink, expiresAt: "2026-11-21T10:00:00.000Z", emailed: true }),
      }),
    );
    await openPage("/admin/users");

    await chooseAction("Users", "Una User", "Actions for Una User", "Send re-link link");
    const dialog = await screen.findByRole("dialog", { name: "Send a re-link link to Una User?" });
    expect(within(dialog).getByText(/removes their old linked sign-ins and signs them out everywhere/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));

    const created = await screen.findByRole("dialog", { name: "Re-link link created" });
    expect(within(created).getByRole("group", { name: "Re-link link" }).querySelector("code")?.textContent).toBe(relink);
    expect(within(created).getByText("Emailed to una@example.com.")).toBeDefined();
  });

  it("offers no unlink for a user's only linked sign-in", async () => {
    stubApi(handlers([una], []));
    await openPage("/admin/users");

    await screen.findByRole("table", { name: "Users" });
    fireEvent.click(within(rowOf("Users", "Una User")).getByRole("button", { name: "Actions for Una User" }));
    const blocked = await screen.findByRole<HTMLButtonElement>("menuitem", { name: "Only one sign-in: send a re-link link instead" });
    expect(blocked.disabled).toBe(true);
  });
});

describe("Admin → Users → Invitations", () => {
  it("creates an invitation and shows its link", async () => {
    const fetchMock = stubApi(
      handlers([], [], {
        [`POST ${invitationsPath}`]: () =>
          json(201, { invitation: { ...pending, sendByEmail: false, verifyEmail: false }, link, emailed: false }),
      }),
    );
    await openPage("/admin/users/invitations");

    await screen.findByText("No invitations yet");
    fireEvent.click(screen.getAllByRole("button", { name: "Invite user" })[0] ?? document.body);
    const dialog = await screen.findByRole("dialog", { name: "Invite user" });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: "new@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));

    const created = await screen.findByRole("dialog", { name: "Invitation created" });
    expect(within(created).getByRole("group", { name: "Invitation link" }).querySelector("code")?.textContent).toBe(link);
    expect(within(created).getByText("Copy the link and send it to the person you're inviting.")).toBeDefined();
    expect(requestsTo(fetchMock, `POST ${invitationsPath}`).map((request) => request.body)).toEqual([
      { email: "new@example.com", expiresInDays: 7, sendByEmail: false, verifyEmail: false },
    ]);
  });

  it("keeps sending and verifying off without an email or without email set up", async () => {
    stubApi(handlers([], [], { [`GET ${mailPath}`]: () => json(200, { smtp: null }) }));
    await openPage("/admin/users/invitations");

    fireEvent.click(screen.getAllByRole("button", { name: "Invite user" })[0] ?? document.body);
    const dialog = await screen.findByRole("dialog", { name: "Invite user" });
    const send = within(dialog).getByRole<HTMLInputElement>("checkbox", { name: /Send the invitation to this email/ });
    const verify = within(dialog).getByRole<HTMLInputElement>("checkbox", { name: /Require a verified matching email/ });
    expect(send.disabled).toBe(true);
    expect(verify.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: "new@example.com" } });
    expect(send.disabled).toBe(true);
    expect(within(dialog).getByText("Set up email on the Email tab of Settings first.")).toBeDefined();
    expect(verify.disabled).toBe(false);
  });

  it("locks the verified email on while sending, and sends both flags", async () => {
    const fetchMock = stubApi(
      handlers([], [], {
        [`GET ${mailPath}`]: () => json(200, { smtp }),
        [`POST ${invitationsPath}`]: () => json(201, { invitation: pending, link, emailed: true }),
      }),
    );
    await openPage("/admin/users/invitations");

    fireEvent.click(screen.getAllByRole("button", { name: "Invite user" })[0] ?? document.body);
    const dialog = await screen.findByRole("dialog", { name: "Invite user" });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: "new@example.com" } });
    const send = within(dialog).getByRole<HTMLInputElement>("checkbox", { name: /Send the invitation to this email/ });
    const verify = within(dialog).getByRole<HTMLInputElement>("checkbox", { name: /Require a verified matching email/ });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    expect(verify.checked).toBe(true);
    expect(verify.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));

    const created = await screen.findByRole("dialog", { name: "Invitation created" });
    expect(within(created).getByText(/We emailed the invitation to new@example.com/)).toBeDefined();
    expect(requestsTo(fetchMock, `POST ${invitationsPath}`).map((request) => request.body)).toEqual([
      { email: "new@example.com", expiresInDays: 7, sendByEmail: true, verifyEmail: true },
    ]);
  });

  it("says when the email could not be sent", async () => {
    stubApi(
      handlers([], [], {
        [`GET ${mailPath}`]: () => json(200, { smtp }),
        [`POST ${invitationsPath}`]: () => json(201, { invitation: pending, link, emailed: false }),
      }),
    );
    await openPage("/admin/users/invitations");

    fireEvent.click(screen.getAllByRole("button", { name: "Invite user" })[0] ?? document.body);
    const dialog = await screen.findByRole("dialog", { name: "Invite user" });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: "new@example.com" } });
    const send = within(dialog).getByRole<HTMLInputElement>("checkbox", { name: /Send the invitation to this email/ });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));

    expect(await screen.findByText(/The email could not be sent/)).toBeDefined();
  });

  it("marks emailed and verified invitations, and offers Resend only for emailed ones", async () => {
    const plain: Invitation = {
      ...pending,
      id: "6d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e503",
      email: "plain@example.com",
      sendByEmail: false,
      verifyEmail: false,
    };
    stubApi(handlers([], [pending, plain]));
    await openPage("/admin/users/invitations");

    await screen.findByRole("table", { name: "Invitations" });
    const emailed = rowOf("Invitations", "new@example.com");
    expect(within(emailed).getByText("Sent by email")).toBeDefined();
    expect(within(emailed).getByText("Verified email required")).toBeDefined();
    expect(within(rowOf("Invitations", "plain@example.com")).queryByText("Sent by email")).toBeNull();

    fireEvent.click(within(emailed).getByRole("button", { name: "Actions for the invitation new@example.com" }));
    expect(await screen.findByRole("menuitem", { name: "Resend" })).toBeDefined();
  });

  it("offers no Resend for an invitation that was not emailed", async () => {
    stubApi(handlers([], [{ ...pending, sendByEmail: false, verifyEmail: false }]));
    await openPage("/admin/users/invitations");

    await chooseAction("Invitations", "new@example.com", "Actions for the invitation new@example.com", "Copy link");
    expect(screen.queryByRole("menuitem", { name: "Resend" })).toBeNull();
  });

  it("points to the Resources page while no home root is set", async () => {
    stubApi(handlers([], [], { [`POST ${invitationsPath}`]: () => problem(409, problemTypes.homeRootNotSet) }));
    await openPage("/admin/users/invitations");

    fireEvent.click(screen.getAllByRole("button", { name: "Invite user" })[0] ?? document.body);
    const dialog = await screen.findByRole("dialog", { name: "Invite user" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));

    expect(await within(dialog).findByText(/Set the home root on the/)).toBeDefined();
    expect(within(dialog).getByRole("link", { name: "Resources page" }).getAttribute("href")).toBe("/admin/resources");
  });

  it("revokes a pending invitation after a confirmation", async () => {
    const fetchMock = stubApi(handlers([], [pending], { [`DELETE ${invitationsPath}/${pending.id}`]: () => noContent() }));
    await openPage("/admin/users/invitations");

    await chooseAction("Invitations", "new@example.com", "Actions for the invitation new@example.com", "Revoke");
    const dialog = await screen.findByRole("dialog", { name: "Revoke this invitation?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke invitation" }));

    expect(await screen.findByText("Invitation revoked")).toBeDefined();
    await waitFor(() => expect(requestsTo(fetchMock, `DELETE ${invitationsPath}/${pending.id}`)).toHaveLength(1));
  });

  it("shows each invitation's state", async () => {
    stubApi(handlers([], [pending, { ...pending, id: "6d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e502", email: null, state: "revoked" }]));
    await openPage("/admin/users/invitations");

    await screen.findByRole("table", { name: "Invitations" });
    expect(within(rowOf("Invitations", "new@example.com")).getByText("Pending")).toBeDefined();
    expect(within(rowOf("Invitations", "No email")).getByText("Revoked")).toBeDefined();
    expect(within(rowOf("Invitations", "No email")).queryByRole("button")).toBeNull();
  });
});
