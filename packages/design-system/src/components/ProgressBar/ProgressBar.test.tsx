import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar.tsx";

function fillOf(bar: HTMLElement): HTMLElement {
  const fill = bar.querySelector("span");
  if (fill === null) throw new Error("No fill");
  return fill;
}

describe("ProgressBar", () => {
  it("is a named progressbar whose fill width is the share of max", () => {
    render(<ProgressBar label="Upload of report.pdf" value={25} max={200} valueText="25 of 200 bytes" />);
    const bar = screen.getByRole("progressbar", { name: "Upload of report.pdf" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuemax")).toBe("200");
    expect(bar.getAttribute("aria-valuetext")).toBe("25 of 200 bytes");
    const fill = fillOf(bar);
    expect(fill.style.getPropertyValue("--nu-progress")).toBe("12.5%");
    expect(fill.classList).toContain("w-(--nu-progress)");
    expect(fill.classList).toContain("bg-accent");
  });

  it("keeps the fill inside the track and takes a tone", () => {
    render(<ProgressBar label="Quota" value={150} tone="danger" />);
    const bar = screen.getByRole("progressbar", { name: "Quota" });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    const fill = fillOf(bar);
    expect(fill.style.getPropertyValue("--nu-progress")).toBe("100%");
    expect(fill.classList).toContain("bg-danger");
  });

  it("is indeterminate without a value", () => {
    render(<ProgressBar label="Waiting" />);
    const bar = screen.getByRole("progressbar", { name: "Waiting" });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(fillOf(bar).classList).toContain("w-1/3");
  });
});
