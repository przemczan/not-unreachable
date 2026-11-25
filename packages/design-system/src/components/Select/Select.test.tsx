import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Select } from "./Select.tsx";

describe("Select", () => {
  it("renders a native combobox named by its label, options from strings", () => {
    render(<Select label="Role" options={["Admin", "Editor", "Viewer"]} defaultValue="Viewer" />);
    const select = screen.getByLabelText<HTMLSelectElement>("Role");
    expect(select).toBe(screen.getByRole("combobox", { name: "Role" }));
    expect(select.value).toBe("Viewer");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Admin", "Editor", "Viewer"]);
  });

  it("takes { value, label } options and calls onChange with the value", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(
      <Select
        aria-label="Status"
        options={[
          { value: "all", label: "All statuses" },
          { value: "active", label: "Active" },
        ]}
        onChange={onChange}
      />,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "Active");
    expect(onChange).toHaveBeenCalledWith("active", expect.anything());
  });

  it("starts on a disabled placeholder option", () => {
    render(<Select aria-label="Role" placeholder="Choose a role" options={["Admin"]} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox");
    expect(select.value).toBe("");
    const placeholder = screen.getByRole<HTMLOptionElement>("option", { name: "Choose a role" });
    expect(placeholder.disabled).toBe(true);
    expect(placeholder.selected).toBe(true);
  });

  it("is controlled with value", () => {
    render(<Select aria-label="Role" options={["Admin", "Viewer"]} value="Admin" onChange={() => undefined} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("Admin");
  });

  it("uses border-control, md size and a chevron", () => {
    const { container } = render(<Select aria-label="Role" options={["Admin"]} className="w-48" />);
    const select = screen.getByRole("combobox");
    expect(select.classList).toContain("border-border-control");
    expect(select.classList).toContain("focus-visible:shadow-focus");
    expect(select.classList).toContain("h-control-md");
    expect(select.classList).toContain("appearance-none");
    expect(select.parentElement?.classList).toContain("w-48");
    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it.each([
    ["sm", "h-control-sm"],
    ["lg", "h-control-lg"],
  ] as const)("sizes %s", (size, expected) => {
    render(<Select aria-label="Role" size={size} options={["Admin"]} />);
    expect(screen.getByRole("combobox").classList).toContain(expected);
  });

  it("shows the error: invalid and described by the error", () => {
    render(<Select label="Role" options={["Admin"]} error="Choose a role" />);
    const select = screen.getByRole("combobox", { name: "Role" });
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(select.getAttribute("aria-describedby")).toBe(screen.getByText("Choose a role").id);
    expect(select.classList).toContain("aria-invalid:border-danger");
  });

  it("is disabled", () => {
    render(<Select aria-label="Role" options={["Admin"]} disabled />);
    expect(screen.getByRole<HTMLSelectElement>("combobox").disabled).toBe(true);
  });
});
