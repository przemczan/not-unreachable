import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthLayout } from "./AuthLayout.tsx";

describe("AuthLayout", () => {
  it("shows the Logo above a card titled by its h1, with the description, content and caption", () => {
    render(
      <AuthLayout title="Sign in" description="Use your account." footer="Every sign-in is logged.">
        <button type="submit">Continue</button>
      </AuthLayout>,
    );

    const main = screen.getByRole("main");
    const card = screen.getByRole("region", { name: "Sign in" });
    expect(main.contains(card)).toBe(true);
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
    expect(screen.getByText("Use your account.")).toBeDefined();
    expect(card.contains(screen.getByRole("button", { name: "Continue" }))).toBe(true);
    expect(card.contains(screen.getByText("Every sign-in is logged."))).toBe(false);
    expect(screen.getByText("NotUnreachable")).toBeDefined();
  });

  it("puts the card on the dialog radius and raised shadow, in a 380px column", () => {
    render(<AuthLayout title="Sign in" />);
    const card = screen.getByRole("region", { name: "Sign in" });

    expect(card.className).toContain("rounded-dialog");
    expect(card.className).toContain("shadow-raised");
    expect(card.className).toContain("p-7");
    expect(card.parentElement?.className).toContain("max-w-95");
  });

  it("leaves out the heading and caption when not given", () => {
    render(<AuthLayout>content</AuthLayout>);

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("content")).toBeDefined();
  });
});
