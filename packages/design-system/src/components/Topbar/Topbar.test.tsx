import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Topbar } from "./Topbar.tsx";

describe("Topbar", () => {
  it("is a sticky banner with its three slots in order", () => {
    render(<Topbar left={<span>Left</span>} center={<input aria-label="Search" />} right={<button type="button">Me</button>} />);
    const bar = screen.getByRole("banner");
    expect(bar.classList).toContain("sticky");
    expect(bar.classList).toContain("h-topbar");
    expect(bar.children).toHaveLength(3);
    expect(bar.children[0]?.textContent).toBe("Left");
    expect(screen.getByRole("textbox", { name: "Search" }).parentElement).toBe(bar.children[1]);
    expect(screen.getByRole("button", { name: "Me" }).parentElement).toBe(bar.children[2]);
  });

  it("leaves out the centre slot without center, and scrolls when not sticky", () => {
    render(<Topbar left="Left" sticky={false} className="px-4" />);
    const bar = screen.getByRole("banner");
    expect(bar.children).toHaveLength(2);
    expect(bar.classList).toContain("relative");
    expect(bar.classList).not.toContain("sticky");
    expect(bar.classList).toContain("px-4");
  });
});
