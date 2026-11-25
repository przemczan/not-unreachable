import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toast, ToastProvider, useToast, type ToastOptions } from "./Toast.tsx";

function Trigger({ toast }: { readonly toast: ToastOptions }) {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(toast)}>
      Sign out session
    </button>
  );
}

function renderWithProvider(toast: ToastOptions) {
  render(
    <ToastProvider>
      <Trigger toast={toast} />
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Toast", () => {
  it("is a status card with its title, description, action and a dismiss button", async () => {
    const onClose = vi.fn<() => void>();
    render(
      <Toast
        tone="success"
        title="Link revoked"
        description="Nobody can open it now."
        action={<button type="button">Undo</button>}
        onClose={onClose}
      />,
    );
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Link revoked");
    expect(toast.textContent).toContain("Nobody can open it now.");
    expect(toast.classList).toContain("shadow-floating");
    expect(toast.querySelector(".text-success-fg svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("ToastProvider and useToast", () => {
    it("has an empty live region before any toast, and shows toasts in it", async () => {
      renderWithProvider({ tone: "success", title: "Session signed out" });
      const region = screen.getByRole("status");
      expect(region.textContent).toBe("");
      expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Sign out session" }));
      expect(region.textContent).toContain("Session signed out");
      // One live region: the cards inside don't announce again.
      expect(screen.getAllByRole("status")).toHaveLength(1);
    });

    it("removes a toast after its duration, 5 seconds by default", () => {
      vi.useFakeTimers();
      renderWithProvider({ title: "Settings saved" });
      fireEvent.click(screen.getByRole("button", { name: "Sign out session" }));
      expect(screen.getByText("Settings saved")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(4999);
      });
      expect(screen.getByText("Settings saved")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByText("Settings saved")).toBeNull();
    });

    it("keeps a toast with duration 0 until it is dismissed", () => {
      vi.useFakeTimers();
      renderWithProvider({ title: "Upload complete", duration: 0 });
      fireEvent.click(screen.getByRole("button", { name: "Sign out session" }));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("Upload complete")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText("Upload complete")).toBeNull();
    });

    it("stacks several toasts, newest last", async () => {
      renderWithProvider({ title: "Link revoked", duration: 0 });
      const button = screen.getByRole("button", { name: "Sign out session" });
      await userEvent.click(button);
      await userEvent.click(button);
      expect(screen.getAllByText("Link revoked")).toHaveLength(2);
    });

    it("fails clearly without a provider", () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(() => render(<Trigger toast={{ title: "x" }} />)).toThrow("useToast() needs a <ToastProvider> above it.");
    });
  });
});
