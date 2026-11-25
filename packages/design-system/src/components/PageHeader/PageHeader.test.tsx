import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader.tsx";

describe("PageHeader", () => {
  it("renders the title as the page's h1 with its description", () => {
    render(<PageHeader title="Users" description="Everyone with access." />);
    const heading = screen.getByRole("heading", { level: 1, name: "Users" });
    expect(heading.classList).toContain("type-page-title");
    expect(screen.getByText("Everyone with access.").classList).toContain("text-fg-2");
  });

  it("places eyebrow, meta, actions and children", () => {
    render(
      <PageHeader
        title="Marta Kowalska"
        eyebrow={<a href="/users">Users</a>}
        meta={<span>Active</span>}
        actions={<button type="button">Edit</button>}
        className="mb-6"
      >
        <div role="tablist" aria-label="Sections" />
      </PageHeader>,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.nextElementSibling?.textContent).toBe("Active");
    expect(screen.getByRole("link", { name: "Users" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeTruthy();
  });

  it("leaves out the optional parts", () => {
    const { container } = render(<PageHeader title="Users" />);
    expect(container.querySelector("p")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
