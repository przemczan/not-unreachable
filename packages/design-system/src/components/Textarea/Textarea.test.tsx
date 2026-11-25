import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { Textarea } from "./Textarea.tsx";

describe("Textarea", () => {
  it("renders a textbox named by its label, 4 rows by default", () => {
    render(<Textarea label="Internal note" hint="Only visible to admins" />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("Internal note");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.rows).toBe(4);
    expect(textarea.getAttribute("aria-describedby")).toBe(screen.getByText("Only visible to admins").id);
  });

  it("takes rows, typing and a ref", async () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea aria-label="Note" rows={3} ref={ref} />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Note" });
    expect(ref.current).toBe(textarea);
    expect(textarea.rows).toBe(3);
    await userEvent.type(textarea, "Hi");
    expect(textarea.value).toBe("Hi");
  });

  it("uses border-control with focus styles and merges className", () => {
    render(<Textarea aria-label="Note" className="mt-2" />);
    const { classList } = screen.getByRole("textbox");
    expect(classList).toContain("border-border-control");
    expect(classList).toContain("focus-visible:border-border-focus");
    expect(classList).toContain("focus-visible:shadow-focus");
    expect(classList).toContain("mt-2");
  });

  it("shows the error: invalid and described by the error", () => {
    render(<Textarea label="Reason" error="Give a reason" />);
    const textarea = screen.getByRole("textbox", { name: "Reason" });
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.getAttribute("aria-describedby")).toBe(screen.getByText("Give a reason").id);
    expect(textarea.classList).toContain("aria-invalid:border-danger");
  });

  it("is disabled and required", () => {
    render(<Textarea label="Reason" disabled required />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Reason" });
    expect(textarea.disabled).toBe(true);
    expect(textarea.required).toBe(true);
  });
});
