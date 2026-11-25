import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Radio, RadioGroup, type RadioGroupOption } from "./Radio.tsx";

const options: RadioGroupOption[] = [
  { value: "email", label: "Email", description: "Default" },
  { value: "sms", label: "SMS" },
  { value: "push", label: "Push" },
];

function Controlled({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("email");
  return (
    <RadioGroup
      label="Notify by"
      options={options}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("Radio", () => {
  it("renders a native radio named by its label, described by its description", () => {
    render(<Radio name="channel" value="email" label="Email" description="Default" />);
    const radio = screen.getByLabelText("Email");
    expect(radio).toBe(screen.getByRole("radio", { name: "Email" }));
    expect(radio.getAttribute("aria-describedby")).toBe(screen.getByText("Default").id);
    expect(radio.classList).toContain("border-border-control");
    expect(radio.classList).toContain("checked:border-accent");
  });

  it("calls onChange with true when selected", async () => {
    const onChange = vi.fn<(checked: boolean) => void>();
    render(<Radio label="Email" checked={false} onChange={onChange} />);
    await userEvent.click(screen.getByText("Email"));
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("is disabled", () => {
    render(<Radio label="Email" disabled />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Email" }).disabled).toBe(true);
  });
});

describe("RadioGroup", () => {
  it("is a radiogroup named by its label, radios sharing one name", () => {
    render(<Controlled />);
    const group = screen.getByRole("radiogroup", { name: "Notify by" });
    const radios = screen.getAllByRole<HTMLInputElement>("radio");
    expect(group.contains(radios[0] ?? null)).toBe(true);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Email" }).checked).toBe(true);
  });

  it("selects on click", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByText("Push"));
    expect(onChange).toHaveBeenCalledWith("push");
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Push" }).checked).toBe(true);
  });

  it("moves and selects with ArrowDown and ArrowRight", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Controlled onChange={onChange} />);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Email" }));

    await userEvent.keyboard("{ArrowDown}");
    const sms = screen.getByRole<HTMLInputElement>("radio", { name: "SMS" });
    expect(document.activeElement).toBe(sms);
    expect(sms.checked).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("sms");

    await userEvent.keyboard("{ArrowRight}");
    const push = screen.getByRole<HTMLInputElement>("radio", { name: "Push" });
    expect(document.activeElement).toBe(push);
    expect(push.checked).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("push");
  });

  it("is uncontrolled with defaultValue and lays out in a row", () => {
    render(<RadioGroup aria-label="Channel" options={options} defaultValue="sms" direction="row" />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "SMS" }).checked).toBe(true);
    expect(screen.getByRole("radiogroup", { name: "Channel" }).querySelector(".flex-row")).not.toBeNull();
  });

  it("disables every option when disabled, or one option", () => {
    const { rerender } = render(<RadioGroup aria-label="Channel" options={[...options, { value: "fax", label: "Fax", disabled: true }]} />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Fax" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "SMS" }).disabled).toBe(false);
    rerender(<RadioGroup aria-label="Channel" options={options} disabled />);
    expect(screen.getAllByRole<HTMLInputElement>("radio").every((radio) => radio.disabled)).toBe(true);
  });
});
