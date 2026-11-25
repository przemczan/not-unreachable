import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Breadcrumbs } from "./Breadcrumbs.tsx";

describe("Breadcrumbs", () => {
  it("is a breadcrumb navigation list whose last crumb is the current page", () => {
    render(<Breadcrumbs items={[{ label: "Users", href: "/users" }, { label: "Marta Kowalska" }]} />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Users" }).getAttribute("href")).toBe("/users");
    expect(screen.queryByRole("link", { name: "Marta Kowalska" })).toBeNull();
    expect(screen.getByText("Marta Kowalska").getAttribute("aria-current")).toBe("page");
  });

  it("hides the separators from assistive technology", () => {
    render(<Breadcrumbs items={[{ label: "A" }, { label: "B" }, { label: "C" }]} />);
    const separators = screen.getAllByText("/");
    expect(separators).toHaveLength(2);
    for (const separator of separators) expect(separator.getAttribute("aria-hidden")).toBe("true");
  });

  it("calls onClick instead of following the link", async () => {
    const onClick = vi.fn<() => void>();
    render(<Breadcrumbs items={[{ label: "Users", onClick }, { label: "Marta" }]} />);
    const link = screen.getByRole("link", { name: "Users" });
    expect(link.getAttribute("href")).toBe("#");
    await userEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders nothing but an empty list without items", () => {
    render(<Breadcrumbs className="mx-2" />);
    const nav = screen.getByRole("navigation");
    expect(nav.classList).toContain("mx-2");
    expect(within(nav).queryAllByRole("listitem")).toHaveLength(0);
  });
});
