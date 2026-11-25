import { type UploadLimits } from "@not-unreachable/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adminSession, baseHandlers, json, renderApp, requestsTo, stubApi, type MockHandler } from "../testing/index.ts";

const saved: UploadLimits = {
  maxFileBytes: 50_000_000_000,
  diskReserve: { percent: 5, bytes: 5_000_000_000 },
  inProgressPerAccount: 4,
  inProgressPerInstance: 100,
  createdPerAccountPerHour: 20,
};

const path = "/api/v1/admin/settings/limits";

function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return { ...baseHandlers({ session: adminSession }), [`GET ${path}`]: () => json(200, saved), ...extra };
}

async function openTab(): Promise<void> {
  renderApp("/admin/settings/limits");
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  await screen.findByLabelText("Largest file");
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("Admin settings → Limits", () => {
  it("has its tab and shows the saved limits, sizes in GB", async () => {
    stubApi(handlers());
    await openTab();

    const tabs = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(tabs).getByRole("link", { name: "Limits" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText<HTMLInputElement>("Largest file").value).toBe("50");
    expect(screen.getByLabelText<HTMLInputElement>("Free space to keep, share").value).toBe("5");
    expect(screen.getByLabelText<HTMLInputElement>("Free space to keep, amount").value).toBe("5");
    expect(screen.getByLabelText<HTMLInputElement>("Per account").value).toBe("4");
    expect(screen.getByLabelText<HTMLInputElement>("On the whole instance").value).toBe("100");
    expect(screen.getByLabelText<HTMLInputElement>("New uploads per account per hour").value).toBe("20");
    expect(screen.queryByText("You have unsaved changes")).toBeNull();
  });

  it("saves the edited limits, sizes as bytes", async () => {
    const updated: UploadLimits = { ...saved, maxFileBytes: 2_500_000_000, inProgressPerAccount: 6 };
    const fetchMock = stubApi(handlers({ [`PUT ${path}`]: () => json(200, updated) }));
    await openTab();

    type("Largest file", "2.5");
    type("Per account", "6");
    expect(screen.getByText("You have unsaved changes")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Limits saved")).toBeDefined();
    expect(requestsTo(fetchMock, `PUT ${path}`).map((request) => request.body)).toEqual([updated]);
    expect(screen.queryByText("You have unsaved changes")).toBeNull();
  });

  it("refuses a value out of range on its field, without saving", async () => {
    const fetchMock = stubApi(handlers());
    await openTab();

    type("Free space to keep, share", "60");
    type("Per account", "0");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Enter a whole number from 0 to 50.")).toBeDefined();
    expect(screen.getByText("Enter a whole number from 1 to 100.")).toBeDefined();
    expect(requestsTo(fetchMock, `PUT ${path}`)).toHaveLength(0);
  });

  it("discards the changes", async () => {
    stubApi(handlers());
    await openTab();
    type("Largest file", "1");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText<HTMLInputElement>("Largest file").value).toBe("50");
  });
});
