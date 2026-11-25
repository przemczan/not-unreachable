import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Alert } from "./Alert.tsx";

describe("Alert", () => {
  it("is a polite status with an info tone by default", () => {
    render(<Alert title="Connection works">The share answered in 184 ms.</Alert>);
    const alert = screen.getByRole("status");
    expect(alert.textContent).toContain("Connection works");
    expect(alert.textContent).toContain("The share answered in 184 ms.");
    expect(alert.classList).toContain("bg-info-subtle");
  });

  it("announces a danger alert at once", () => {
    render(<Alert tone="danger">The email or password is wrong.</Alert>);
    const alert = screen.getByRole("alert");
    expect(alert.classList).toContain("bg-danger-subtle");
    expect(alert.classList).toContain("border-danger-border");
  });

  it.each([
    ["success", "bg-success-subtle"],
    ["warning", "bg-warning-subtle"],
    ["neutral", "bg-surface-raised"],
  ] as const)("styles the %s tone", (tone, expected) => {
    render(<Alert tone={tone}>Message</Alert>);
    expect(screen.getByRole("status").classList).toContain(expected);
  });

  it("renders an action and a dismiss button", async () => {
    const onClose = vi.fn<() => void>();
    render(
      <Alert action={<button type="button">Try again</button>} onClose={onClose}>
        Failed
      </Alert>,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has no dismiss button without onClose", () => {
    render(<Alert>Message</Alert>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
