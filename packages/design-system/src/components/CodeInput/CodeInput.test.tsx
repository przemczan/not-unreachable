import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CodeInput, type CodeInputProps } from "./CodeInput.tsx";

function Controlled(props: Partial<CodeInputProps>) {
  const [value, setValue] = useState("");
  return (
    <CodeInput
      label="Authenticator code"
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
    />
  );
}

const box = (position: number) => screen.getByRole<HTMLInputElement>("textbox", { name: `Digit ${position} of 6` });
const shown = () => [1, 2, 3, 4, 5, 6].map((position) => box(position).value).join("");

describe("CodeInput", () => {
  it("is a group of 6 numeric boxes named by its label, the first taking one-time-code autofill", () => {
    render(<Controlled />);
    expect(screen.getByRole("group", { name: "Authenticator code" })).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(6);
    expect(box(1).getAttribute("autocomplete")).toBe("one-time-code");
    expect(box(1).getAttribute("inputmode")).toBe("numeric");
    expect(box(2).getAttribute("autocomplete")).toBe("off");
  });

  it("moves to the next box while typing, skips non-digits and reports the whole code once complete", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(value: string) => void>();
    render(<Controlled onComplete={onComplete} />);

    await user.click(box(1));
    await user.keyboard("12a3456");

    expect(shown()).toBe("123456");
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("123456");
  });

  it("fills every box from a pasted or autofilled code, spaces and all", () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Controlled onChange={onChange} />);

    fireEvent.change(box(1), { target: { value: "123 456" } });

    expect(shown()).toBe("123456");
    expect(onChange).toHaveBeenLastCalledWith("123456");
  });

  it("goes back a box on Backspace in an empty one, and keeps the digits without gaps", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.click(box(1));
    await user.keyboard("123");
    await user.keyboard("{Backspace}");
    expect(shown()).toBe("12");
    expect(document.activeElement).toBe(box(3));

    // A box past the first empty one sends focus back to it.
    await user.click(box(1));
    await user.click(box(6));
    expect(document.activeElement).toBe(box(3));
  });

  it("shows the error: every box invalid and described by it", () => {
    render(<CodeInput label="Authenticator code" value="" onChange={() => undefined} error="The code is not right." />);
    const message = screen.getByText("The code is not right.");
    expect(box(1).getAttribute("aria-invalid")).toBe("true");
    expect(box(6).getAttribute("aria-describedby")).toBe(message.id);
  });

  it("disables every box", () => {
    render(<CodeInput aria-label="Code" value="" onChange={() => undefined} disabled />);
    expect(screen.getByRole("group", { name: "Code" })).toBeTruthy();
    expect(screen.getAllByRole<HTMLInputElement>("textbox").every((input) => input.disabled)).toBe(true);
  });
});
