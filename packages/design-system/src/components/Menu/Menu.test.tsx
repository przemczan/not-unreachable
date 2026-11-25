import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { toCssLength } from "../../lib/toCssLength.ts";
import { Menu, type MenuItem, type MenuProps } from "./Menu.tsx";

function renderMenu(props: Partial<MenuProps> = {}) {
  const onEdit = vi.fn<() => void>();
  const onDelete = vi.fn<() => void>();
  const items: MenuItem[] = [
    { heading: "Row" },
    { label: "Edit", onSelect: onEdit, shortcut: "E" },
    { label: "Duplicate" },
    { label: "Archive", disabled: true },
    { divider: true },
    { label: "Delete", danger: true, onSelect: onDelete },
  ];
  render(
    <>
      <Menu trigger={<button type="button">Actions</button>} items={items} {...props} />
      <button type="button">Outside</button>
    </>,
  );
  return { onEdit, onDelete, trigger: screen.getByRole("button", { name: "Actions" }) };
}

const menu = () => screen.getByRole("menu", { hidden: true });
const isOpen = () => menu().hasAttribute("data-popover-open");
const item = (name: string | RegExp) => screen.getByRole("menuitem", { name });

describe("Menu", () => {
  it("wires the trigger to a closed manual popover menu", () => {
    const { trigger } = renderMenu();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(menu().id);
    expect(menu().getAttribute("popover")).toBe("manual");
    expect(menu().getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(isOpen()).toBe(false);
  });

  it("opens on click, named by its trigger, and focuses the first item", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(item(/^Edit/));
    expect(screen.getAllByRole("menuitem").map((element) => element.textContent)).toEqual(["EditE", "Duplicate", "Archive", "Delete"]);
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it.each(["{Enter}", " ", "{ArrowDown}"])("opens from the keyboard with %s", async (key) => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard(key);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(item(/^Edit/));
  });

  it("opens at the last item with ArrowUp", async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(item("Delete"));
  });

  it("moves with the arrow keys, skipping disabled items and wrapping, and jumps with Home/End", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Duplicate"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Delete"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item(/^Edit/));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(item("Delete"));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(item(/^Edit/));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(item("Delete"));
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("calls the item's handler on selection, closes and refocuses the trigger", async () => {
    const { trigger, onEdit, onDelete } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Enter}");
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);

    await userEvent.click(trigger);
    await userEvent.click(item("Delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  it("does not select a disabled item", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    expect(item("Archive").hasAttribute("disabled")).toBe(true);
  });

  it("closes on a click outside and on a second trigger click", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(isOpen()).toBe(false);
    await userEvent.click(trigger);
    expect(isOpen()).toBe(true);
    await userEvent.click(trigger);
    expect(isOpen()).toBe(false);
  });

  it("styles danger items and places itself through custom properties", async () => {
    const { trigger } = renderMenu({ width: 240, align: "start" });
    await userEvent.click(trigger);
    expect(item("Delete").classList).toContain("text-danger-fg");
    expect(item(/^Edit/).classList).toContain("text-fg-1");
    expect(menu().style.getPropertyValue("--nu-menu-w")).toBe(toCssLength(240));
    expect(menu().classList).toContain("left-(--nu-menu-x)");
    expect(menu().classList).not.toContain("-translate-x-full");
  });

  it("aligns to the trigger's end by default", () => {
    renderMenu();
    expect(menu().classList).toContain("-translate-x-full");
  });

  it("follows a controlled open prop and reports changes", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    renderMenu({ open: true, onOpenChange });
    expect(isOpen()).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(isOpen()).toBe(true);
  });
});
