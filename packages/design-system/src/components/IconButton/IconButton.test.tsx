import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Icon } from "../Icon/index.ts";
import { IconButton, IconButtonLink } from "./IconButton.tsx";

describe("IconButton", () => {
  it("is named by its label, which is also its title", () => {
    render(<IconButton label="More" icon={<Icon name="more-horizontal" />} />);
    const button = screen.getByRole("button", { name: "More" });
    expect(button.getAttribute("title")).toBe("More");
    expect(button.getAttribute("type")).toBe("button");
  });

  it("is ghost and md by default", () => {
    render(<IconButton label="More" icon={<Icon name="more-horizontal" />} />);
    const { classList } = screen.getByRole("button");
    expect(classList).toContain("bg-transparent");
    expect(classList).toContain("text-fg-2");
    expect(classList).toContain("size-control-md");
  });

  it.each([
    ["secondary", "border-border-strong"],
    ["primary", "bg-primary"],
  ] as const)("styles the %s variant", (variant, expected) => {
    render(<IconButton variant={variant} label="Add" icon={<Icon name="plus" />} />);
    expect(screen.getByRole("button").classList).toContain(expected);
  });

  it.each([
    ["xs", "size-control-xs"],
    ["sm", "size-control-sm"],
    ["lg", "size-control-lg"],
  ] as const)("sizes %s", (size, expected) => {
    render(<IconButton size={size} label="Add" icon={<Icon name="plus" />} />);
    expect(screen.getByRole("button").classList).toContain(expected);
  });

  it("calls onClick, but not when disabled", async () => {
    const onClick = vi.fn<() => void>();
    const { rerender } = render(<IconButton label="Add" icon={<Icon name="plus" />} onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<IconButton label="Add" icon={<Icon name="plus" />} onClick={onClick} disabled />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Add" });
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("IconButtonLink", () => {
  it("is a link named by its label, which is also its title, passing download through", () => {
    render(<IconButtonLink href="/files/report.pdf" download label="Download report.pdf" icon={<Icon name="download" />} />);
    const link = screen.getByRole("link", { name: "Download report.pdf" });
    expect(link.getAttribute("href")).toBe("/files/report.pdf");
    expect(link.getAttribute("title")).toBe("Download report.pdf");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("is ghost and md by default, and sizes", () => {
    render(
      <>
        <IconButtonLink href="/a" label="A" icon={<Icon name="download" />} />
        <IconButtonLink href="/b" label="B" size="sm" variant="secondary" icon={<Icon name="download" />} />
      </>,
    );
    const { classList: ghost } = screen.getByRole("link", { name: "A" });
    expect(ghost).toContain("bg-transparent");
    expect(ghost).toContain("size-control-md");
    const { classList: secondary } = screen.getByRole("link", { name: "B" });
    expect(secondary).toContain("border-border-strong");
    expect(secondary).toContain("size-control-sm");
  });
});
