import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState.tsx";

describe("EmptyState", () => {
  it("shows an icon, the title, the description and the action", () => {
    const { container } = render(
      <EmptyState
        icon="folder-open"
        title="No files yet"
        description="Upload files or create a folder to start."
        action={<button type="button">Upload files</button>}
      />,
    );
    expect(screen.getByText("No files yet").classList).toContain("type-card-title");
    expect(screen.getByText("Upload files or create a folder to start.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses the inbox icon and full padding by default, less when compact", () => {
    const { container, rerender } = render(<EmptyState title="Nothing here" />);
    expect(container.firstElementChild?.classList).toContain("py-12");
    expect(container.querySelector("svg")?.classList).toContain("lucide-inbox");
    rerender(<EmptyState title="Nothing here" compact />);
    expect(container.firstElementChild?.classList).toContain("py-6");
  });
});
