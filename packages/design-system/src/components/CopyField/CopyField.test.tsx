import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CopyField, type CopyOutcome } from "./CopyField.tsx";

const command = "sudo not-unreachable allow-folder /srv/files";

describe("CopyField", () => {
  it("shows the value as text in Geist Mono, in a group named by its label", () => {
    render(<CopyField label="Command" value={command} />);
    const group = screen.getByRole("group", { name: "Command" });
    expect(group.querySelector("code")?.textContent).toBe(command);
    expect(group.querySelector("code")?.classList).toContain("type-mono");
  });

  it("copies the value, confirms it and reports the outcome", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn<(outcome: CopyOutcome) => void>();
    render(<CopyField label="Command" value={command} onCopy={onCopy} />);

    await user.click(screen.getByRole("button", { name: "Copy command" }));

    expect(await navigator.clipboard.readText()).toBe(command);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Copied");
    expect(onCopy).toHaveBeenCalledWith("copied");
  });

  it("says to copy by hand when the clipboard refuses", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const onCopy = vi.fn<(outcome: CopyOutcome) => void>();
    render(<CopyField value={command} what="Command" onCopy={onCopy} />);

    await user.click(screen.getByRole("button", { name: "Copy command" }));

    expect(screen.getByRole("status").textContent).toBe("Copying did not work. Select the command and copy it by hand.");
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(onCopy).toHaveBeenCalledWith("failed");
  });
});
