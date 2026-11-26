import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu, type SelectMenuOption, type SelectMenuProps } from "./SelectMenu.tsx";

const resources: readonly SelectMenuOption[] = [
  { value: "media", label: "Media", description: "Local folder · /srv/media" },
  { value: "music", label: "Music" },
  { value: "nas", label: "NAS", description: "SMB share · //nas/files" },
  { value: "notes", label: "Notes" },
];

/** A SelectMenu that keeps the chosen value, as a caller would. */
function Resources({ onChange, ...props }: Partial<SelectMenuProps>) {
  const [value, setValue] = useState("music");
  return (
    <>
      <SelectMenu
        label="Resource"
        hint="Whose files to show"
        value={value}
        options={resources}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        {...props}
      />
      <button type="button">Elsewhere</button>
    </>
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Resource" });
const listbox = () => screen.getByRole("listbox", { hidden: true });
const activeOption = () => document.getElementById(trigger().getAttribute("aria-activedescendant") ?? "")?.textContent;

describe("SelectMenu", () => {
  it("is a combobox button named by its label, showing the chosen label, controlling a closed listbox", () => {
    render(<Resources />);
    expect(trigger().tagName).toBe("BUTTON");
    expect(trigger().textContent).toBe("Music");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBe(listbox().id);
    expect(trigger().getAttribute("aria-activedescendant")).toBeNull();
    expect(screen.getByText("Whose files to show").id).toBe(trigger().getAttribute("aria-describedby"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on click at the chosen option, marked with a check", async () => {
    render(<Resources />);
    await userEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const music = screen.getByRole("option", { name: "Music" });
    expect(trigger().getAttribute("aria-activedescendant")).toBe(music.id);
    expect(music.getAttribute("aria-selected")).toBe("true");
    expect(music.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("option", { name: /^Media/ }).querySelector("svg")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("shows each option's description under its label, with a title", async () => {
    render(<Resources />);
    await userEvent.click(trigger());
    const description = screen.getByText("Local folder · /srv/media");
    expect(description.getAttribute("title")).toBe("Local folder · /srv/media");
    expect(description.classList).toContain("type-caption");
    expect(screen.getByRole("option", { name: /^Media/ }).contains(description)).toBe(true);
    expect(trigger().textContent).toBe("Music");
  });

  it.each(["{Enter}", " ", "{ArrowDown}", "{ArrowUp}"])("opens on %s at the chosen option", async (key) => {
    render(<Resources />);
    trigger().focus();
    await userEvent.keyboard(key);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(activeOption()).toBe("Music");
  });

  it("moves with the arrow keys, stopping at the ends, and jumps with Home and End", async () => {
    render(<Resources />);
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(activeOption()).toMatch(/^NAS/);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(activeOption()).toBe("Notes");
    await userEvent.keyboard("{Home}");
    expect(activeOption()).toMatch(/^Media/);
    await userEvent.keyboard("{ArrowUp}");
    expect(activeOption()).toMatch(/^Media/);
    await userEvent.keyboard("{End}");
    expect(activeOption()).toBe("Notes");
    expect(screen.getByRole("option", { name: "Notes" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("option", { name: "Music" }).getAttribute("aria-selected")).toBe("false");
  });

  it("moves to the option whose label starts with what is typed, cycling on a repeated letter", async () => {
    render(<Resources />);
    trigger().focus();
    await userEvent.keyboard("n");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(activeOption()).toMatch(/^NAS/);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await userEvent.keyboard("n");
    expect(activeOption()).toBe("Notes");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await userEvent.keyboard("me");
    expect(activeOption()).toMatch(/^Media/);
  });

  it("chooses the active option with Enter, closing and keeping focus on the trigger", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Resources onChange={onChange} />);
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("nas");
    expect(trigger().textContent).toBe("NAS");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("chooses the active option with Space", async () => {
    render(<Resources />);
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}{Home}");
    await userEvent.keyboard(" ");
    expect(trigger().textContent).toBe("Media");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("chooses an option on click, keeping focus on the trigger", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Resources onChange={onChange} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: /^NAS/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("nas");
    expect(trigger().textContent).toBe("NAS");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("doesn't call onChange when the chosen option is chosen again", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Resources onChange={onChange} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: "Music" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on Escape without choosing, focus staying on the trigger, and not past it", async () => {
    const onOuterKeyDown = vi.fn<(event: React.KeyboardEvent) => void>();
    render(
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={onOuterKeyDown}>
        <Resources />
      </div>,
    );
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Escape}");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent).toBe("Music");
    expect(document.activeElement).toBe(trigger());
    expect(onOuterKeyDown.mock.calls.map(([event]) => event.key)).not.toContain("Escape");
  });

  it("closes on Tab without choosing", async () => {
    render(<Resources />);
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.tab();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent).toBe("Music");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Elsewhere" }));
  });

  it("closes on a click outside", async () => {
    render(<Resources />);
    await userEvent.click(trigger());
    await userEvent.click(document.body);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent).toBe("Music");
  });

  it("toggles on clicking the trigger again", async () => {
    render(<Resources />);
    await userEvent.click(trigger());
    await userEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("is named by aria-label without a Field label", () => {
    render(<SelectMenu aria-label="Resource" value="media" options={resources} onChange={() => undefined} />);
    expect(trigger().textContent).toBe("Media");
  });

  it("shows the placeholder while the value matches no option", () => {
    render(<SelectMenu aria-label="Resource" placeholder="Choose one" value="" options={resources} onChange={() => undefined} />);
    expect(trigger().textContent).toBe("Choose one");
  });

  it("shows the error: invalid and described by the error", () => {
    render(<SelectMenu label="Resource" value="media" options={resources} onChange={() => undefined} error="Choose a resource" required />);
    expect(trigger().getAttribute("aria-invalid")).toBe("true");
    expect(trigger().getAttribute("aria-required")).toBe("true");
    expect(trigger().getAttribute("aria-describedby")).toBe(screen.getByText("Choose a resource").id);
    expect(trigger().classList).toContain("aria-invalid:border-danger");
  });

  it.each([
    ["sm", "h-control-sm"],
    ["md", "h-control-md"],
    ["lg", "h-control-lg"],
  ] as const)("sizes %s", (size, expected) => {
    render(<SelectMenu aria-label="Resource" size={size} value="media" options={resources} onChange={() => undefined} />);
    expect(trigger().classList).toContain(expected);
  });

  it("puts className on the wrapper and lets the list be wider than the trigger", async () => {
    render(<SelectMenu aria-label="Resource" className="w-48" value="media" options={resources} onChange={() => undefined} />);
    expect(trigger().parentElement?.classList).toContain("w-48");
    await userEvent.click(trigger());
    expect(screen.getByRole("listbox").classList).toContain("min-w-full");
    expect(screen.getByRole("listbox").classList).toContain("max-w-96");
  });

  it("is disabled: neither a click nor a key opens it", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<SelectMenu aria-label="Resource" value="media" options={resources} onChange={onChange} disabled />);
    expect(trigger()).toHaveProperty("disabled", true);
    await userEvent.click(trigger());
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });
});
