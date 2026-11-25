import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tooltip } from "./Tooltip.tsx";

function renderTooltip(props: { side?: "top" | "bottom" | "left" | "right"; open?: boolean } = {}) {
  return render(
    <>
      <Tooltip content="Export CSV" {...props}>
        <button type="button">Export</button>
      </Tooltip>
      <button type="button">Elsewhere</button>
    </>,
  );
}

const tooltip = () => screen.getByRole("tooltip", { hidden: true });
const isOpen = (element: HTMLElement) => element.hasAttribute("data-popover-open");

describe("Tooltip", () => {
  it("is a manual popover that describes its trigger, hidden at first", () => {
    renderTooltip();
    const trigger = screen.getByRole("button", { name: "Export" });
    expect(tooltip().getAttribute("popover")).toBe("manual");
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip().id);
    expect(isOpen(tooltip())).toBe(false);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on keyboard focus and hides on blur", async () => {
    renderTooltip();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Export" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Export CSV");
    expect(screen.getByRole("button", { name: "Export" }).getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export", description: "Export CSV" })).toBeTruthy();
    await userEvent.tab();
    expect(isOpen(tooltip())).toBe(false);
  });

  it("hides on Escape and keeps focus on the trigger", async () => {
    renderTooltip();
    await userEvent.tab();
    expect(isOpen(tooltip())).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(isOpen(tooltip())).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Export" }));
  });

  it("shows on hover and hides on mouse leave", async () => {
    renderTooltip();
    await userEvent.hover(screen.getByRole("button", { name: "Export" }));
    expect(isOpen(tooltip())).toBe(true);
    await userEvent.unhover(screen.getByRole("button", { name: "Export" }));
    expect(isOpen(tooltip())).toBe(false);
  });

  it("stays open when forced, and positions through custom properties only", async () => {
    renderTooltip({ open: true, side: "right" });
    const element = screen.getByRole("tooltip");
    expect(element.style.getPropertyValue("--nu-tooltip-x")).toMatch(/px$/);
    expect(element.classList).toContain("left-(--nu-tooltip-x)");
    expect(element.classList).toContain("-translate-y-1/2");
    await userEvent.keyboard("{Escape}");
    expect(isOpen(element)).toBe(true);
  });

  it("anchors above the trigger by default", () => {
    renderTooltip({ open: true });
    expect(screen.getByRole("tooltip").classList).toContain("-translate-y-full");
  });
});
