import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Disclosure } from "./Disclosure.tsx";

const groupOf = (title: string): HTMLDetailsElement => {
  const details = screen.getByText(title).closest("details");
  if (details === null) throw new Error("no details");
  return details;
};

describe("Disclosure", () => {
  it("starts closed, and opens and closes from its title", async () => {
    render(<Disclosure title="How to set this up">Steps</Disclosure>);
    const details = groupOf("How to set this up");
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText("How to set this up"));
    expect(details.open).toBe(true);
    await userEvent.click(screen.getByText("How to set this up"));
    expect(details.open).toBe(false);
  });

  it("starts open when asked", () => {
    render(
      <Disclosure title="How to set this up" defaultOpen>
        Steps
      </Disclosure>,
    );
    expect(groupOf("How to set this up").open).toBe(true);
    expect(screen.getByText("Steps")).toBeTruthy();
  });
});
