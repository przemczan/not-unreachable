import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./Checkbox.tsx";

describe("Checkbox", () => {
  it("renders a native checkbox named by its label, described by its description", () => {
    render(<Checkbox label="Send weekly report" description="Every Monday at 08:00" />);
    const checkbox = screen.getByLabelText("Send weekly report");
    expect(checkbox).toBe(screen.getByRole("checkbox", { name: "Send weekly report" }));
    expect(checkbox.getAttribute("aria-describedby")).toBe(screen.getByText("Every Monday at 08:00").id);
  });

  it("calls onChange with the new state, controlled", async () => {
    const onChange = vi.fn<(checked: boolean) => void>();
    render(<Checkbox label="Weekly" checked={false} onChange={onChange} />);
    await userEvent.click(screen.getByText("Weekly"));
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("toggles uncontrolled with the keyboard", async () => {
    render(<Checkbox aria-label="Weekly" defaultChecked />);
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "Weekly" });
    expect(checkbox.checked).toBe(true);
    checkbox.focus();
    await userEvent.keyboard(" ");
    expect(checkbox.checked).toBe(false);
  });

  it("sets the indeterminate state on the input", () => {
    const { rerender } = render(<Checkbox aria-label="Select all" indeterminate />);
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox");
    expect(checkbox.indeterminate).toBe(true);
    rerender(<Checkbox aria-label="Select all" />);
    expect(checkbox.indeterminate).toBe(false);
  });

  it("forwards its ref and styles checked states in CSS", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Checkbox aria-label="Row" ref={ref} className="mt-2" />);
    const checkbox = screen.getByRole("checkbox");
    expect(ref.current).toBe(checkbox);
    expect(checkbox.classList).toContain("border-border-control");
    expect(checkbox.classList).toContain("checked:bg-accent");
    expect(checkbox.classList).toContain("focus-visible:shadow-focus");
    expect(checkbox.closest("label")?.classList).toContain("mt-2");
  });

  it("is disabled and ignores clicks", async () => {
    const onChange = vi.fn<(checked: boolean) => void>();
    render(<Checkbox label="Weekly" disabled onChange={onChange} />);
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "Weekly" });
    expect(checkbox.disabled).toBe(true);
    await userEvent.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();
  });
});
