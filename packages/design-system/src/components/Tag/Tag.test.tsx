import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tag } from "./Tag.tsx";

describe("Tag", () => {
  it("is a toggle button with onClick, pressed when selected", async () => {
    const onClick = vi.fn<() => void>();
    const { rerender } = render(<Tag onClick={onClick}>Failed</Tag>);
    const tag = screen.getByRole("button", { name: "Failed", pressed: false });
    expect(tag.classList).toContain("rounded-full");
    expect(tag.classList).toContain("bg-surface");
    await userEvent.click(tag);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Tag onClick={onClick} selected>
        Failed
      </Tag>,
    );
    const pressed = screen.getByRole("button", { name: "Failed", pressed: true });
    expect(pressed.classList).toContain("bg-surface-inverse");
    expect(pressed.classList).toContain("text-fg-inverse");
  });

  it("is a static label without handlers", () => {
    render(<Tag>Admin</Tag>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Admin").classList).toContain("rounded-full");
  });

  it("shows a count", () => {
    render(
      <Tag onClick={() => undefined} count={12}>
        Failed
      </Tag>,
    );
    expect(screen.getByRole("button", { name: "Failed12" }).textContent).toBe("Failed12");
  });

  it("has a remove button with its own name, next to the toggle", async () => {
    const onClick = vi.fn<() => void>();
    const onRemove = vi.fn<() => void>();
    render(
      <Tag onClick={onClick} onRemove={onRemove} removeLabel="Remove filter: Failed">
        Failed
      </Tag>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove filter: Failed" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("names the remove button Remove filter by default", () => {
    render(<Tag onRemove={() => undefined}>Failed</Tag>);
    expect(screen.getByRole("button", { name: "Remove filter" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
