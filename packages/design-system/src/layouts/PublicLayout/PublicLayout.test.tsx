import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PublicLayout } from "./PublicLayout.tsx";

describe("PublicLayout", () => {
  it("shows a Topbar with only the Logo, and the content in main", () => {
    render(
      <PublicLayout>
        <h1>Shared file</h1>
      </PublicLayout>,
    );

    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("NotUnreachable")).toBeDefined();
    expect(within(banner).queryAllByRole("button")).toHaveLength(0);
    expect(within(banner).queryAllByRole("link")).toHaveLength(0);
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Shared file" })).toBeDefined();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
