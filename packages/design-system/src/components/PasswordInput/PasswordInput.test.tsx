import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PasswordInput } from "./PasswordInput.tsx";

describe("PasswordInput", () => {
  it("is a password input named by its label, autocomplete current-password", () => {
    render(<PasswordInput label="Password" />);
    const input = screen.getByLabelText("Password");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("current-password");
  });

  it("passes autoComplete through", () => {
    render(<PasswordInput label="New password" autoComplete="new-password" />);
    expect(screen.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
  });

  it("toggles between hidden and shown", async () => {
    render(<PasswordInput label="Password" />);
    const input = screen.getByLabelText("Password");
    const show = screen.getByRole("button", { name: "Show password" });
    expect(show.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(show);
    expect(input.getAttribute("type")).toBe("text");
    const hide = screen.getByRole("button", { name: "Hide password" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(hide);
    expect(input.getAttribute("type")).toBe("password");
    expect(screen.getByRole("button", { name: "Show password" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps what was typed when toggled", async () => {
    render(<PasswordInput label="Password" />);
    const input = screen.getByLabelText<HTMLInputElement>("Password");
    await userEvent.type(input, "s3cret");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.value).toBe("s3cret");
  });

  it("shows the error: invalid and described by the error", () => {
    render(<PasswordInput label="Password" error="Wrong password" />);
    const input = screen.getByLabelText("Password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("Wrong password").id);
  });

  it("disables the input and the reveal button", () => {
    render(<PasswordInput label="Password" disabled />);
    expect(screen.getByLabelText<HTMLInputElement>("Password").disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Show password" }).disabled).toBe(true);
  });
});
