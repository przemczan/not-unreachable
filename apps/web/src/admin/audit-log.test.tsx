import type { AuditEvent } from "@not-unreachable/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adminSession, baseHandlers, json, renderApp, stubApi } from "../testing/index.ts";

const markup = `<img src=x onerror="alert(1)">`;

/** An event whose every free-text field is markup an attacker could have put there (T4). */
const hostile: AuditEvent = {
  id: "01900000-0000-7000-8000-000000000001",
  at: "2026-11-24T10:15:00.000Z",
  actorKind: "account",
  actorAccountId: "01900000-0000-7000-8000-000000000002",
  actorUsername: `${markup}user`,
  action: "linked-sign-in.added",
  targetKind: `${markup}kind`,
  targetId: `${markup}id`,
  outcome: "succeeded",
  ip: "203.0.113.7",
  userAgent: `${markup}agent<script>alert(2)</script>`,
  details: { email: `${markup}@example.com`, nested: { name: `<b>${markup}</b>` } },
};

describe("Admin → Audit log", () => {
  it("shows actor, target, user agent and details as text only", async () => {
    stubApi({
      ...baseHandlers({ session: adminSession }),
      "GET /api/v1/admin/audit-events": () => json(200, { events: [hostile], nextCursor: null }),
    });
    renderApp("/admin/audit-log");

    expect(await screen.findByText(/^by <img src=x onerror="alert\(1\)">user/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText(`${markup}agent<script>alert(2)</script>`)).toBeDefined();
    expect(within(drawer).getByText(`${markup}kind`)).toBeDefined();
    expect(within(drawer).getByText(`${markup}id`)).toBeDefined();
    const details = within(drawer).getByRole("region", { name: "Event details" });
    expect(details.textContent).toContain(`<b>${markup.replaceAll('"', '\\"')}</b>`);

    expect(document.querySelector("img[src=x], script:not([src]), b")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
  });
});
