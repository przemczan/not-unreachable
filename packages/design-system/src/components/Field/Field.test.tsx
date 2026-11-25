import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "../Input/index.ts";
import { Field, useFieldControl } from "./Field.tsx";

function CustomControl() {
  const field = useFieldControl();
  return (
    <input
      id={field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid === true ? true : undefined}
      required={field?.required}
    />
  );
}

describe("Field", () => {
  it("labels the control inside it", () => {
    render(
      <Field label="Email">
        <Input type="email" />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input.tagName).toBe("INPUT");
    expect(screen.getByRole("textbox", { name: "Email" })).toBe(input);
  });

  it("uses htmlFor as the control's id", () => {
    render(
      <Field label="Name" htmlFor="name">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText("Name").id).toBe("name");
  });

  it("describes the control with the hint", () => {
    render(
      <Field label="Email" hint="Used for sign-in">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText("Used for sign-in").id).toBe(input.getAttribute("aria-describedby"));
    expect(screen.getByText("Used for sign-in").classList).toContain("text-fg-3");
  });

  it("replaces the hint with the error and marks the control invalid", () => {
    render(
      <Field label="Seats" hint="Whole seats" error="Enter a whole number">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Seats" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByText("Whole seats")).toBeNull();
    const error = screen.getByText("Enter a whole number");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(error.classList).toContain("text-danger-fg");
  });

  it("shows a hidden required marker and sets required on the control", () => {
    render(
      <Field label="Email" required>
        <Input />
      </Field>,
    );
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Email" });
    expect(input.required).toBe(true);
    expect(screen.getByText("*").getAttribute("aria-hidden")).toBe("true");
  });

  it("wires a custom control through useFieldControl", () => {
    render(
      <Field label="Code" error="Wrong code" required>
        <CustomControl />
      </Field>,
    );
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Code" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.required).toBe(true);
    expect(input).toHaveProperty("id", screen.getByText("Code", { selector: "label" }).getAttribute("for"));
    expect(screen.getByText("Wrong code").id).toBe(input.getAttribute("aria-describedby"));
  });

  it("merges className", () => {
    const { container } = render(
      <Field label="Email" className="mt-2">
        <Input />
      </Field>,
    );
    expect(container.firstElementChild?.classList).toContain("mt-2");
  });
});
