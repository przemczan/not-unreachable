import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Input } from "./Input.tsx";

describe("Input", () => {
  it("renders a textbox named by its label, with the hint as description", () => {
    render(<Input label="Email" hint="Used for sign-in" placeholder="name@company.com" />);
    const input = screen.getByLabelText("Email");
    expect(input).toBe(screen.getByRole("textbox", { name: "Email" }));
    expect(input.getAttribute("placeholder")).toBe("name@company.com");
    expect(screen.getByText("Used for sign-in").id).toBe(input.getAttribute("aria-describedby"));
  });

  it("is controlled and passes native attributes through", async () => {
    const onChange = vi.fn<() => void>();
    render(<Input aria-label="Name" name="name" defaultValue="" onChange={onChange} maxLength={10} />);
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
    await userEvent.type(input, "Ada");
    expect(input.value).toBe("Ada");
    expect(input.name).toBe("name");
    expect(input.maxLength).toBe(10);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("forwards its ref to the input", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input aria-label="Name" ref={ref} />);
    expect(ref.current).toBe(screen.getByRole("textbox"));
  });

  it("keeps an explicit id and labels it", () => {
    render(<Input id="email" label="Email" />);
    expect(screen.getByLabelText("Email").id).toBe("email");
  });

  it("uses border-control, focus and md size on the box by default", () => {
    render(<Input aria-label="Name" />);
    const box = screen.getByRole("textbox").parentElement;
    expect(box?.classList).toContain("border-border-control");
    expect(box?.classList).toContain("focus-within:border-border-focus");
    expect(box?.classList).toContain("focus-within:shadow-focus");
    expect(box?.classList).toContain("h-control-md");
  });

  it.each([
    ["sm", "h-control-sm", "type-body-sm"],
    ["lg", "h-control-lg", "type-body"],
  ] as const)("sizes %s", (size, height, type) => {
    render(<Input aria-label="Name" size={size} />);
    const input = screen.getByRole("textbox");
    expect(input.parentElement?.classList).toContain(height);
    expect(input.classList).toContain(type);
  });

  it("renders iconLeft and suffix inside the box", () => {
    render(<Input aria-label="Search" iconLeft={<span data-testid="icon" />} suffix={<kbd>/</kbd>} />);
    const box = screen.getByRole("textbox").parentElement;
    expect(box?.firstElementChild).toBe(screen.getByTestId("icon"));
    expect(box?.lastElementChild?.tagName).toBe("KBD");
  });

  it("merges className on the box and inputClassName on the input", () => {
    render(<Input aria-label="Name" className="w-64" inputClassName="text-right" />);
    const input = screen.getByRole("textbox");
    expect(input.parentElement?.classList).toContain("w-64");
    expect(input.classList).toContain("text-right");
  });

  it("shows the error: invalid, described by the error, red border", () => {
    render(<Input label="Seats" hint="Whole seats" error="Enter a whole number" />);
    const input = screen.getByRole("textbox", { name: "Seats" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("Enter a whole number").id);
    expect(screen.queryByText("Whole seats")).toBeNull();
    expect(input.parentElement?.classList).toContain("has-aria-invalid:border-danger");
  });

  it("keeps the same input element when an error appears", () => {
    const { rerender } = render(<Input label="Seats" />);
    const before = screen.getByRole("textbox");
    rerender(<Input label="Seats" error="Enter a whole number" />);
    expect(screen.getByRole("textbox")).toBe(before);
  });

  it("is disabled", () => {
    render(<Input aria-label="Name" disabled />);
    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect(input.disabled).toBe(true);
    expect(input.parentElement?.classList).toContain("has-disabled:bg-surface-sunken");
  });

  it("sets required", () => {
    render(<Input label="Email" required />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Email" }).required).toBe(true);
  });
});
