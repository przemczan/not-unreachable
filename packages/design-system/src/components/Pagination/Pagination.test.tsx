import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Pagination } from "./Pagination.tsx";

const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

describe("Pagination", () => {
  it("is a navigation landmark with a summary and Previous / Next", () => {
    render(<Pagination summary="Showing 50 events" hasPrevious hasNext />);
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeTruthy();
    expect(screen.getByText("Showing 50 events").classList).toContain("tabular-nums");
    expect(button("Previous").disabled).toBe(false);
    expect(button("Next").disabled).toBe(false);
  });

  it("disables each direction without a page that way", () => {
    render(<Pagination hasNext />);
    expect(button("Previous").disabled).toBe(true);
    expect(button("Next").disabled).toBe(false);
  });

  it("calls onPrevious and onNext", async () => {
    const onPrevious = vi.fn<() => void>();
    const onNext = vi.fn<() => void>();
    render(<Pagination hasPrevious hasNext onPrevious={onPrevious} onNext={onNext} />);
    await userEvent.click(button("Previous"));
    await userEvent.click(button("Next"));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("disables both while loading, and takes its own name", () => {
    render(<Pagination hasPrevious hasNext loading aria-label="Audit log pages" />);
    expect(screen.getByRole("navigation", { name: "Audit log pages" })).toBeTruthy();
    expect(button("Previous").disabled).toBe(true);
    expect(button("Next").disabled).toBe(true);
  });
});
