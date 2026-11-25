import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExpiryPicker, defaultExpiryValue, expiryDateOf, toLocalDateTimeInput, type ExpiryValue } from "./ExpiryPicker.tsx";

const now = new Date(2026, 10, 25, 14, 30);
const DAY_MS = 24 * 60 * 60 * 1000;

function Controlled({ onChange, allowNever }: { onChange?: (value: ExpiryValue) => void; allowNever?: boolean }) {
  const [value, setValue] = useState(defaultExpiryValue);
  return (
    <ExpiryPicker
      now={now}
      value={value}
      {...(allowNever === undefined ? {} : { allowNever })}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const checked = () => screen.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;

describe("ExpiryPicker", () => {
  it("is a labelled group of presets, 7 days by default, saying when that is", () => {
    render(<Controlled />);
    expect(screen.getByRole("group", { name: "Expires" })).toBeDefined();
    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["1 day", "7 days", "30 days", "Custom", "No expiry"]);
    expect(checked()).toBe("7 days");
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(now.getTime() + 7 * DAY_MS),
    );
    expect(screen.getByText(`Expires ${expected}.`)).toBeDefined();
    expect(screen.queryByLabelText("Expiry date and time")).toBeNull();
  });

  it("picks a preset, and No expiry", async () => {
    const onChange = vi.fn<(value: ExpiryValue) => void>();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "30 days" }));
    expect(onChange).toHaveBeenLastCalledWith({ preset: "30d", custom: "" });
    await userEvent.click(screen.getByRole("radio", { name: "No expiry" }));
    expect(onChange).toHaveBeenLastCalledWith({ preset: "never", custom: "" });
    expect(screen.getByText("It never expires.")).toBeDefined();
  });

  it("shows a datetime-local input for Custom, starting from the preset chosen before", async () => {
    const onChange = vi.fn<(value: ExpiryValue) => void>();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));

    const input = screen.getByLabelText<HTMLInputElement>("Expiry date and time");
    expect(input.type).toBe("datetime-local");
    expect(input.value).toBe(toLocalDateTimeInput(new Date(now.getTime() + 7 * DAY_MS)));
    expect(input.min).toBe("2026-11-25T14:30");

    fireEvent.change(input, { target: { value: "2026-12-24T18:00" } });
    expect(onChange).toHaveBeenLastCalledWith({ preset: "custom", custom: "2026-12-24T18:00" });
  });

  it("shows an error on the custom time", () => {
    render(<ExpiryPicker now={now} value={{ preset: "custom", custom: "" }} error="Choose a time in the future." />);
    const input = screen.getByLabelText("Expiry date and time");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Choose a time in the future.")).toBeDefined();
  });

  it("leaves No expiry out with allowNever false, and takes its own label", () => {
    const { unmount } = render(<Controlled allowNever={false} />);
    expect(screen.queryByRole("radio", { name: "No expiry" })).toBeNull();
    unmount();
    render(<ExpiryPicker label="Link expires" />);
    expect(screen.getByRole("group", { name: "Link expires" })).toBeDefined();
  });

  it("is uncontrolled with defaultValue", async () => {
    render(<ExpiryPicker now={now} defaultValue={{ preset: "1d", custom: "" }} />);
    expect(checked()).toBe("1 day");
    await userEvent.click(screen.getByRole("radio", { name: "30 days" }));
    expect(checked()).toBe("30 days");
  });
});

describe("expiryDateOf", () => {
  it("reads a preset as days from now, No expiry as null, and a custom time as typed", () => {
    expect(expiryDateOf({ preset: "1d", custom: "" }, now)).toEqual(new Date(now.getTime() + DAY_MS));
    expect(expiryDateOf({ preset: "30d", custom: "" }, now)).toEqual(new Date(now.getTime() + 30 * DAY_MS));
    expect(expiryDateOf({ preset: "never", custom: "" }, now)).toBeNull();
    expect(expiryDateOf({ preset: "custom", custom: "2026-12-24T18:00" }, now)).toEqual(new Date(2026, 11, 24, 18, 0));
  });

  it("is undefined for an empty or invalid custom time", () => {
    expect(expiryDateOf({ preset: "custom", custom: "" }, now)).toBeUndefined();
    expect(expiryDateOf({ preset: "custom", custom: "not a time" }, now)).toBeUndefined();
  });
});
