import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropZone } from "./DropZone.tsx";

const report = new File(["hello"], "report.pdf", { type: "application/pdf" });

function drag(type: "dragEnter" | "dragOver" | "dragLeave" | "drop", types: string[] = ["Files"], files: File[] = []): void {
  act(() => {
    fireEvent[type](window, { dataTransfer: { types, files, dropEffect: "none" } });
  });
}

describe("DropZone", () => {
  it("shows a named full-page overlay only while files are dragged over the window", () => {
    render(<DropZone onFiles={() => undefined} description="Into Photos" />);
    expect(screen.queryByRole("region")).toBeNull();

    drag("dragEnter");
    const overlay = screen.getByRole("region", { name: "Drop files to upload" });
    expect(overlay.classList).toContain("fixed");
    expect(screen.getByText("Into Photos")).toBeTruthy();

    // Entering a child and leaving the parent keeps it; leaving the last one hides it.
    drag("dragEnter");
    drag("dragLeave");
    expect(screen.getByRole("region")).toBeTruthy();
    drag("dragLeave");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("calls onFiles with the dropped files and hides the overlay", () => {
    const onFiles = vi.fn<(files: File[]) => void>();
    render(<DropZone onFiles={onFiles} label="Drop files into Photos" />);
    drag("dragEnter");
    expect(screen.getByRole("region", { name: "Drop files into Photos" })).toBeTruthy();
    drag("drop", ["Files"], [report]);
    expect(onFiles).toHaveBeenCalledWith([report]);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("ignores drags of text and links", () => {
    render(<DropZone onFiles={() => undefined} />);
    drag("dragEnter", ["text/plain"]);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("does nothing when disabled", () => {
    const onFiles = vi.fn<(files: File[]) => void>();
    render(<DropZone onFiles={onFiles} disabled />);
    drag("dragEnter");
    expect(screen.queryByRole("region")).toBeNull();
    drag("drop", ["Files"], [report]);
    expect(onFiles).not.toHaveBeenCalled();
  });
});
