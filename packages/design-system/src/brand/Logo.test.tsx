import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Logo } from "./Logo.tsx";
import { markCut } from "./mark.ts";
import { Wordmark } from "./Wordmark.tsx";

/** The element's first child, which the test expects to be an HTML element. */
function firstChild(parent: Element | null): HTMLElement {
  const child = parent?.firstElementChild;
  if (!(child instanceof HTMLElement)) throw new Error("expected an HTML element");
  return child;
}

describe("Logo", () => {
  it("shows the mark and the name as live text", () => {
    const { container } = render(<Logo />);

    expect(screen.getByText("NotUnreachable")).toBeDefined();
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows only the mark, named NotUnreachable, with variant mark", () => {
    render(<Logo variant="mark" />);

    expect(screen.getByRole("img", { name: "NotUnreachable" })).toBeDefined();
    expect(screen.queryByText("NotUnreachable")).toBeNull();
  });

  it.each(["horizontal", "mark"] as const)("%s: draws mark.ts in currentColor, with no raw colour or <style>", (variant) => {
    const { container } = render(<Logo variant={variant} />);
    const route = container.querySelector("path");
    const node = container.querySelector("circle");

    expect(route?.getAttribute("d")).toBe(markCut.route);
    expect(route?.getAttribute("stroke")).toBe("currentColor");
    expect(node?.getAttribute("fill")).toBe("currentColor");
    expect(container.querySelector("style")).toBeNull();
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
  });

  it("draws the mark in the accent colour on a sunken square, sized by the size prop", () => {
    const { container } = render(<Logo size={32} />);
    const root = firstChild(container);
    const square = firstChild(root);

    expect(square.className).toContain("text-accent");
    expect(square.className).toContain("bg-surface-sunken");
    expect(square.className).toContain("rounded-control");
    expect(root.style.getPropertyValue("--nu-logo-size")).toBe("32px");
    expect(screen.getByText("NotUnreachable").style.getPropertyValue("--nu-wordmark-size")).toBe("24px");
  });

  it.each([
    ["auto", null, ["bg-surface-sunken", "text-accent"], "text-fg-1"],
    ["light", "light", ["bg-surface-sunken", "text-accent"], "text-fg-1"],
    ["dark", "dark", ["bg-surface-sunken", "text-accent"], "text-fg-1"],
    ["mono-ink", "light", ["bg-transparent", "text-fg-1"], "text-fg-1"],
    ["mono-white", "light", ["bg-transparent", "text-fg-inverse"], "text-fg-inverse"],
  ] as const)("tone %s reads its colours from the %s theme", (tone, theme, markClasses, textClass) => {
    const { container } = render(<Logo tone={tone} />);
    const square = firstChild(firstChild(container));

    expect(firstChild(container).getAttribute("data-theme")).toBe(theme);
    for (const markClass of markClasses) expect(square.className).toContain(markClass);
    expect(screen.getByText("NotUnreachable").className).toContain(textClass);
  });
});

describe("Wordmark", () => {
  it("renders the name in Geist semibold, tight tracking, fg-1", () => {
    render(<Wordmark />);
    const name = screen.getByText("NotUnreachable");

    expect(name.className).toContain("font-sans");
    expect(name.className).toContain("font-semibold");
    expect(name.className).toContain("tracking-tight");
    expect(name.className).toContain("text-fg-1");
  });
});
