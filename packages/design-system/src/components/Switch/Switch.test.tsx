import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./Switch.tsx";

describe("Switch", () => {
  it("renders a switch named by its label, described by its description", () => {
    render(<Switch label="Two-factor authentication" description="Required for all admins" />);
    const control = screen.getByLabelText("Two-factor authentication");
    expect(control).toBe(screen.getByRole("switch", { name: "Two-factor authentication" }));
    expect(control.getAttribute("type")).toBe("checkbox");
    expect(control.getAttribute("aria-describedby")).toBe(screen.getByText("Required for all admins").id);
  });

  it("sits right-aligned in a full-width row with a label", () => {
    render(<Switch label="Alerts" />);
    const label = screen.getByRole("switch").closest("label");
    expect(label?.classList).toContain("w-full");
    expect(label?.classList).toContain("justify-between");
    expect(label?.lastElementChild?.contains(screen.getByRole("switch"))).toBe(true);
  });

  it("calls onChange with the new state, controlled", async () => {
    const onChange = vi.fn<(checked: boolean) => void>();
    render(<Switch label="Alerts" checked onChange={onChange} />);
    const control = screen.getByRole<HTMLInputElement>("switch", { name: "Alerts" });
    expect(control.checked).toBe(true);
    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("toggles uncontrolled with Space", async () => {
    render(<Switch aria-label="Alerts" />);
    const control = screen.getByRole<HTMLInputElement>("switch", { name: "Alerts" });
    control.focus();
    await userEvent.keyboard(" ");
    expect(control.checked).toBe(true);
  });

  it.each([
    ["sm", "w-7"],
    ["md", "w-8.5"],
  ] as const)("sizes %s", (size, expected) => {
    render(<Switch aria-label="Alerts" size={size} />);
    const control = screen.getByRole("switch");
    expect(control.classList).toContain(expected);
    expect(control.classList).toContain("checked:bg-accent");
    expect(control.classList).toContain("focus-visible:shadow-focus");
  });

  it("is disabled and ignores clicks", async () => {
    const onChange = vi.fn<(checked: boolean) => void>();
    render(<Switch label="Alerts" disabled onChange={onChange} />);
    const control = screen.getByRole<HTMLInputElement>("switch", { name: "Alerts" });
    expect(control.disabled).toBe(true);
    await userEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});
