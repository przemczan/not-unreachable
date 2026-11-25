import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Drawer } from "./Drawer.tsx";

function Harness({ onClose }: { readonly onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Details
      </button>
      <Drawer
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Session signed out"
        description="20 Oct, 14:02 UTC"
        footer={<button type="button">Copy JSON</button>}
      >
        Fields
      </Drawer>
    </>
  );
}

const drawer = () => screen.getByRole<HTMLDialogElement>("dialog", { hidden: true });

describe("Drawer", () => {
  it("opens as a modal side panel named by its title, with body and footer", async () => {
    render(<Harness />);
    expect(drawer().open).toBe(false);
    expect(screen.queryByText("Fields")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    const named = screen.getByRole("dialog", { name: "Session signed out" });
    expect(named).toBe(drawer());
    expect(drawer().hasAttribute("data-modal")).toBe(true);
    expect(named.getAttribute("aria-describedby")).toBe(screen.getByText("20 Oct, 14:02 UTC").id);
    expect(screen.getByText("Fields")).toBeTruthy();
    expect(screen.getByText("Copy JSON").closest("footer")).not.toBeNull();
  });

  it("shows only while open: a display class would show the closed dialog", () => {
    render(<Drawer open={false} title="Closed" />);
    expect(drawer().classList).toContain("open:flex");
    expect(drawer().classList).not.toContain("flex");
    expect(drawer().classList).toContain("starting:open:translate-x-6");
  });

  it("asks the caller to close on Escape, the close button and the backdrop", async () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Details" });
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(drawer().open).toBe(false);
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.click(opener);
    // jsdom lays nothing out: give the drawer a box, so a point left of it is on the backdrop.
    vi.spyOn(drawer(), "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 500, y: 0, width: 480, height: 800 }));
    fireEvent.pointerDown(drawer(), { clientX: 20, clientY: 400 });
    fireEvent.click(drawer(), { clientX: 20, clientY: 400 });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(drawer().open).toBe(false);
  });

  it("sets its width only through a custom property", () => {
    render(<Drawer title="Wide" width={560} />);
    expect(drawer().getAttribute("style")).toBe("--nu-drawer-w: 560px;");
  });

  it("renders inline as a named aside", () => {
    render(
      <Drawer inline title="Preview">
        Body
      </Drawer>,
    );
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Preview" }).textContent).toContain("Body");
  });
});
