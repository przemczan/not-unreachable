import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UploadQueue, type UploadQueueItem } from "./UploadQueue.tsx";

const items: UploadQueueItem[] = [
  { id: "1", name: "report.pdf", bytesSent: 2_000_000, bytesTotal: 8_000_000, state: "uploading" },
  { id: "2", name: "photo.jpg", bytesSent: 1_000_000, bytesTotal: 4_000_000, state: "paused" },
  { id: "3", name: "notes.txt", bytesSent: 1000, bytesTotal: 1000, state: "done" },
  { id: "4", name: "movie.mkv", bytesSent: 0, bytesTotal: 5_000_000_000, state: "failed", error: "There is not enough space left." },
  { id: "5", name: "song.mp3", bytesSent: 0, bytesTotal: 3_000_000, state: "queued" },
];

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
}

describe("UploadQueue", () => {
  it("renders nothing without items", () => {
    const { container } = render(<UploadQueue items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a docked card with a count and a row per upload with its progress and status", () => {
    render(<UploadQueue items={items} />);
    const card = screen.getByRole("region", { name: "Uploading 3 files" });
    expect(card.classList).toContain("fixed");
    expect(within(card).getByText("1 of 5 uploaded · 1 failed")).toBeTruthy();

    const bar = within(rowOf("report.pdf")).getByRole("progressbar", { name: "Upload of report.pdf" });
    expect(bar.getAttribute("aria-valuenow")).toBe("2000000");
    expect(within(rowOf("report.pdf")).getByText("2 / 8 MB")).toBeTruthy();
    expect(within(rowOf("photo.jpg")).getByText("Paused · 1 / 4 MB")).toBeTruthy();
    expect(within(rowOf("notes.txt")).getByText("Uploaded · 1 KB")).toBeTruthy();
    expect(within(rowOf("movie.mkv")).getByText("There is not enough space left.")).toBeTruthy();
    expect(within(rowOf("song.mp3")).getByText("Waiting · 3 MB")).toBeTruthy();
  });

  it("shows a note instead of the status", () => {
    render(<UploadQueue items={[{ ...items[1]!, note: "Choose photo.jpg again to resume" }]} />);
    expect(screen.getByText("Choose photo.jpg again to resume")).toBeTruthy();
  });

  it("offers pause, resume and cancel by state, and calls back with the id", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn<(id: string) => void>();
    const onResume = vi.fn<(id: string) => void>();
    const onCancel = vi.fn<(id: string) => void>();
    render(<UploadQueue items={items} onPause={onPause} onResume={onResume} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: "Pause upload of report.pdf" }));
    expect(onPause).toHaveBeenCalledWith("1");
    await user.click(screen.getByRole("button", { name: "Resume upload of photo.jpg" }));
    expect(onResume).toHaveBeenCalledWith("2");
    await user.click(screen.getByRole("button", { name: "Cancel upload of song.mp3" }));
    expect(onCancel).toHaveBeenCalledWith("5");
    await user.click(screen.getByRole("button", { name: "Remove upload of movie.mkv" }));
    expect(onCancel).toHaveBeenCalledWith("4");

    expect(within(rowOf("notes.txt")).queryAllByRole("button")).toHaveLength(0);
    expect(within(rowOf("photo.jpg")).queryByRole("button", { name: /Pause/ })).toBeNull();
  });

  it("collapses to its header and closes when it may", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn<() => void>();
    const done: UploadQueueItem[] = [items[2]!];
    render(<UploadQueue items={done} onClose={onClose} />);
    expect(screen.getByRole("region", { name: "Uploads" })).toBeTruthy();

    const collapse = screen.getByRole("button", { name: "Collapse uploads" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await user.click(collapse);
    expect(screen.getByRole("button", { name: "Expand uploads" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("notes.txt").closest("ul")?.hidden).toBe(true);

    await user.click(screen.getByRole("button", { name: "Close uploads" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("has no close button without onClose", () => {
    render(<UploadQueue items={items} />);
    expect(screen.queryByRole("button", { name: "Close uploads" })).toBeNull();
  });
});
