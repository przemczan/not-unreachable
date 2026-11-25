import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge.tsx";

function badgeOf(text: string): HTMLElement {
  const badge = screen.getByText(text).parentElement;
  if (!badge) throw new Error(`No badge around "${text}"`);
  return badge;
}

describe("Badge", () => {
  it("renders its text, neutral and md by default", () => {
    render(<Badge>Draft</Badge>);
    const { classList } = badgeOf("Draft");
    expect(classList).toContain("bg-neutral-subtle");
    expect(classList).toContain("text-neutral-fg");
    expect(classList).toContain("h-5.5");
  });

  it.each([
    ["success", "bg-success-subtle", "text-success-fg"],
    ["warning", "bg-warning-subtle", "text-warning-fg"],
    ["danger", "bg-danger-subtle", "text-danger-fg"],
    ["info", "bg-info-subtle", "text-info-fg"],
    ["accent", "bg-accent-subtle", "text-accent-subtle-fg"],
  ] as const)("colours the %s tone", (tone, bg, fg) => {
    render(<Badge tone={tone}>Status</Badge>);
    const { classList } = badgeOf("Status");
    expect(classList).toContain(bg);
    expect(classList).toContain(fg);
  });

  it("shows a decorative dot in the tone's colour", () => {
    render(
      <Badge tone="danger" dot>
        Suspended
      </Badge>,
    );
    const dot = badgeOf("Suspended").firstElementChild;
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.classList).toContain("bg-danger");
  });

  it("has no dot by default", () => {
    render(<Badge>Draft</Badge>);
    expect(badgeOf("Draft").children).toHaveLength(1);
  });

  it("sets the text in mono and sizes sm", () => {
    render(
      <Badge mono size="sm" className="ml-1">
        ord_10482
      </Badge>,
    );
    expect(screen.getByText("ord_10482").classList).toContain("font-mono");
    const { classList } = badgeOf("ord_10482");
    expect(classList).toContain("h-4.5");
    expect(classList).toContain("ml-1");
  });
});
