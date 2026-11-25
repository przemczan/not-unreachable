import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl.tsx";

const ranges = ["24h", "7d", "30d", "90d"];

function Controlled({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("7d");
  return (
    <SegmentedControl
      aria-label="Range"
      options={ranges}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const checkedName = () => screen.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;

describe("SegmentedControl", () => {
  it("is a named radiogroup of radio buttons, one checked", () => {
    render(<Controlled />);
    expect(screen.getByRole("radiogroup", { name: "Range" })).toBeDefined();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: "7d" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "24h" }).getAttribute("aria-checked")).toBe("false");
  });

  it("has a roving tabindex on the checked option", async () => {
    render(<Controlled />);
    expect(screen.getAllByRole("radio").map((radio) => radio.tabIndex)).toEqual([-1, 0, -1, -1]);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "7d" }));
  });

  it("selects on click", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "90d" }));
    expect(onChange).toHaveBeenCalledWith("90d");
    expect(checkedName()).toBe("90d");
  });

  it("moves and selects with the arrow keys, Home and End, wrapping", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Controlled onChange={onChange} />);
    await userEvent.tab();

    await userEvent.keyboard("{ArrowRight}");
    expect(checkedName()).toBe("30d");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "30d" }));

    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(checkedName()).toBe("24h");

    await userEvent.keyboard("{ArrowLeft}");
    expect(checkedName()).toBe("90d");

    await userEvent.keyboard("{Home}");
    expect(checkedName()).toBe("24h");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "24h" }));

    await userEvent.keyboard("{End}");
    expect(checkedName()).toBe("90d");
    expect(onChange).toHaveBeenLastCalledWith("90d");
    expect(screen.getByRole("radio", { name: "90d" }).tabIndex).toBe(0);
  });

  it("is uncontrolled with defaultValue, and focusable on the first option without a value", async () => {
    const { unmount } = render(<SegmentedControl aria-label="View" options={["List", "Grid"]} defaultValue="Grid" />);
    expect(checkedName()).toBe("Grid");
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(checkedName()).toBe("List");
    unmount();

    render(<SegmentedControl aria-label="View" options={["List", "Grid"]} />);
    expect(screen.getAllByRole("radio").map((radio) => radio.tabIndex)).toEqual([0, -1]);
  });

  it("takes options with icons", () => {
    render(<SegmentedControl aria-label="View" options={[{ value: "list", label: "List", icon: <span data-testid="icon" /> }]} />);
    expect(screen.getByRole("radio", { name: "List" }).firstElementChild).toBe(screen.getByTestId("icon"));
  });

  it.each([
    ["sm", "h-control-sm", "type-caption"],
    ["md", "h-control-md", "type-label"],
  ] as const)("sizes %s", (size, height, type) => {
    render(<SegmentedControl aria-label="Range" size={size} options={ranges} className="ml-2" />);
    const group = screen.getByRole("radiogroup");
    expect(group.classList).toContain(height);
    expect(group.classList).toContain("ml-2");
    expect(screen.getAllByRole("radio")[0]?.classList).toContain(type);
    expect(screen.getAllByRole("radio")[0]?.classList).toContain("aria-checked:bg-surface");
  });
});
