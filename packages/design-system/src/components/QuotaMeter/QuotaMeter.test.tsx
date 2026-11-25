import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuotaMeter } from "./QuotaMeter.tsx";

function fillOf(bar: HTMLElement): HTMLElement {
  const fill = bar.querySelector("span");
  if (fill === null) throw new Error("No fill");
  return fill;
}

describe("QuotaMeter", () => {
  it("shows the used share as a bar and a caption in the limit's unit", () => {
    render(<QuotaMeter usedBytes={4_200_000_000} limitBytes={10_000_000_000} />);
    expect(screen.getByText("4.2 / 10 GB")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Storage" });
    expect(bar.getAttribute("aria-valuetext")).toBe("4.2 / 10 GB");
    expect(fillOf(bar).classList).toContain("bg-accent");
  });

  it.each([
    [8_500_000_000, "bg-warning"],
    [9_600_000_000, "bg-danger"],
  ])("warns near the limit (%d bytes used)", (used, expected) => {
    render(<QuotaMeter label="Your storage" usedBytes={used} limitBytes={10_000_000_000} />);
    expect(fillOf(screen.getByRole("progressbar", { name: "Your storage" })).classList).toContain(expected);
  });

  it("shows danger when the limit is 0", () => {
    render(<QuotaMeter usedBytes={0} limitBytes={0} />);
    expect(screen.getByText("0 / 0 B")).toBeTruthy();
    expect(fillOf(screen.getByRole("progressbar")).classList).toContain("bg-danger");
  });
});
