import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, type DialogProps } from "./Dialog.tsx";

function Harness({ onClose, ...props }: Partial<DialogProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Sign out
      </button>
      <Dialog
        {...props}
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Sign out this session?"
        description="The device has to sign in again."
        actions={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button">Sign out session</button>
          </>
        }
      />
    </>
  );
}

function WithInitialFocus() {
  const field = useRef<HTMLInputElement>(null);
  return (
    <Dialog open title="Confirm it's you" onClose={() => undefined} initialFocus={field}>
      <input aria-label="Password" ref={field} />
    </Dialog>
  );
}

const dialog = () => screen.getByRole<HTMLDialogElement>("dialog", { hidden: true });

/** jsdom lays nothing out: give the dialog a box, so a point outside it is on the backdrop. */
function placeDialog(): void {
  vi.spyOn(dialog(), "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 100, y: 100, width: 480, height: 200 }));
}

const backdrop = { clientX: 20, clientY: 20 };
const insideBox = { clientX: 200, clientY: 290 };

describe("Dialog", () => {
  it("opens as a modal named and described by its title and description", async () => {
    render(<Harness />);
    expect(dialog().open).toBe(false);
    expect(screen.queryByText("Sign out this session?")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(dialog().open).toBe(true);
    expect(dialog().hasAttribute("data-modal")).toBe(true);
    const named = screen.getByRole("dialog", { name: "Sign out this session?" });
    expect(named.getAttribute("aria-describedby")).toBe(screen.getByText("The device has to sign in again.").id);
    expect(screen.getByRole("heading", { level: 2, name: "Sign out this session?" })).toBeTruthy();
  });

  it("focuses the first focusable element when it opens", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("asks the caller to close on Escape", async () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(false);
  });

  it("stays open on Escape until the caller closes it", async () => {
    render(<Dialog open title="Stay" onClose={() => undefined} />);
    await userEvent.keyboard("{Escape}");
    expect(dialog().open).toBe(true);
  });

  it("closes from the close button and the backdrop, once each", async () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    placeDialog();
    fireEvent.pointerDown(dialog(), backdrop);
    fireEvent.click(dialog(), backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(dialog().open).toBe(false);
  });

  it("doesn't close on a click inside the panel, even on a gap between its parts", async () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await userEvent.click(screen.getByText("The device has to sign in again."));
    placeDialog();
    fireEvent.pointerDown(dialog(), insideBox);
    fireEvent.click(dialog(), insideBox);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("doesn't close on a drag that starts inside the panel and ends on the backdrop", async () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    placeDialog();
    fireEvent.pointerDown(screen.getByText("The device has to sign in again."), insideBox);
    // The click of a drag fires on the common ancestor: the dialog.
    fireEvent.click(dialog(), backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves the dialog it is opened over open when it closes or takes Escape", async () => {
    const outerClose = vi.fn<() => void>();
    function Nested() {
      const [inner, setInner] = useState(false);
      return (
        <Dialog open title="Outer" onClose={outerClose}>
          <button type="button" onClick={() => setInner(true)}>
            Open inner
          </button>
          <Dialog open={inner} title="Inner" onClose={() => setInner(false)} />
        </Dialog>
      );
    }
    render(<Nested />);
    await userEvent.click(screen.getByRole("button", { name: "Open inner" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: "Inner" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open inner" }));
    const inner = screen.getByRole("heading", { name: "Inner" }).closest("dialog");
    if (inner === null) throw new Error("No inner dialog");
    await userEvent.click(within(inner).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Inner" })).toBeNull();
    expect(outerClose).not.toHaveBeenCalled();
  });

  it("focuses initialFocus when it opens", () => {
    render(<WithInitialFocus />);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Password" }));
  });

  it("closes without calling onClose when the caller sets open to false", async () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog().open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("has no close button without onClose, and a warning glyph for danger", () => {
    const { container } = render(<Dialog open title="Delete 3 files?" tone="danger" />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(container.querySelector(".bg-danger-subtle svg")).not.toBeNull();
  });

  it("sets its width only through a custom property", () => {
    render(<Dialog open title="Wide" width={640} />);
    expect(dialog().getAttribute("style")).toBe("--nu-dialog-w: 640px;");
    expect(dialog().classList).toContain("w-(--nu-dialog-w)");
    expect(dialog().classList).toContain("rounded-dialog");
  });

  it("renders inline as a named section without a modal", () => {
    render(
      <Dialog inline title="Preview">
        Body
      </Dialog>,
    );
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    expect(screen.getByRole("region", { name: "Preview" }).textContent).toContain("Body");
  });
});
