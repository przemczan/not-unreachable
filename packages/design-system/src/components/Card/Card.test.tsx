import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card.tsx";

describe("Card", () => {
  it("is a region named by its title, with subtitle, actions and footer", () => {
    render(
      <Card title="Revenue" subtitle="Last 30 days" actions={<button type="button">More</button>} footer="Updated now">
        Body
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Revenue" });
    expect(screen.getByRole("heading", { name: "Revenue", level: 3 })).toBeTruthy();
    expect(screen.getByText("Last 30 days")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    expect(screen.getByText("Updated now").tagName).toBe("FOOTER");
    expect(card.classList).toContain("bg-surface");
    expect(card.classList).toContain("rounded-card");
  });

  it("has no header without title or actions, and the body keeps its full padding", () => {
    const { container } = render(<Card>Body</Card>);
    expect(container.querySelector("header")).toBeNull();
    const body = screen.getByText("Body");
    expect(body.classList).toContain("p-5");
    expect(body.classList).not.toContain("pt-3.5");
  });

  it("tightens the body's top under a header", () => {
    render(<Card title="Revenue">Body</Card>);
    const body = screen.getByText("Body");
    expect(body.classList).toContain("p-5");
    expect(body.classList).toContain("pt-3.5");
  });

  it("goes edge to edge with a divided header for padding none", () => {
    const { container } = render(
      <Card title="Orders" padding="none" bodyClassName="overflow-auto">
        Table
      </Card>,
    );
    expect(container.querySelector("header")?.classList).toContain("border-b");
    const body = screen.getByText("Table");
    expect(body.classList).toContain("p-0");
    expect(body.classList).toContain("overflow-auto");
  });

  it.each([
    ["raised", "shadow-raised"],
    ["sunken", "bg-surface-sunken"],
  ] as const)("styles the %s variant", (variant, expected) => {
    render(
      <Card title="T" variant={variant} className="mt-4">
        Body
      </Card>,
    );
    const { classList } = screen.getByRole("region", { name: "T" });
    expect(classList).toContain(expected);
    expect(classList).toContain("mt-4");
  });
});
