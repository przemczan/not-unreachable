import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { Combobox, type ComboboxOption, type ComboboxProps } from "./Combobox.tsx";

const fruits: readonly ComboboxOption[] = [{ value: "apple" }, { value: "apricot" }, { value: "banana", label: "Banana (yellow)" }];

/** A Combobox that filters `fruits` by what is typed, as a caller would. */
function Fruits(props: Partial<ComboboxProps>) {
  const [value, setValue] = useState("");
  const options = fruits.filter((fruit) => fruit.value.startsWith(value));
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <Combobox
        label="Fruit"
        hint="Any fruit"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        options={options}
        onSelect={setValue}
        {...props}
      />
    </form>
  );
}

const input = () => screen.getByRole<HTMLInputElement>("combobox", { name: "Fruit" });
const listbox = () => screen.getByRole("listbox", { hidden: true });

describe("Combobox", () => {
  it("is a combobox named by its label, controlling a listbox, closed at first", () => {
    render(<Fruits />);
    expect(input().getAttribute("aria-controls")).toBe(listbox().id);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    expect(input().getAttribute("autocomplete")).toBe("off");
    expect(screen.getByText("Any fruit").id).toBe(input().getAttribute("aria-describedby"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on typing and shows the options it is given", async () => {
    render(<Fruits />);
    await userEvent.type(input(), "ap");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["apple", "apricot"]);
  });

  it("shows an option's label when it has one", async () => {
    render(<Fruits />);
    await userEvent.click(input());
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Banana (yellow)" })).toBeTruthy();
  });

  it("moves through the options with the arrow keys, wrapping, and chooses with Enter", async () => {
    render(<Fruits />);
    await userEvent.type(input(), "a");
    await userEvent.keyboard("{ArrowDown}");
    const [apple, apricot] = screen.getAllByRole("option");
    expect(input().getAttribute("aria-activedescendant")).toBe(apple?.id);
    expect(apple?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(input().getAttribute("aria-activedescendant")).toBe(apricot?.id);
    await userEvent.keyboard("{ArrowDown}");
    expect(input().getAttribute("aria-activedescendant")).toBe(apple?.id);
    await userEvent.keyboard("{ArrowUp}");
    expect(input().getAttribute("aria-activedescendant")).toBe(apricot?.id);
    await userEvent.keyboard("{Enter}");
    expect(input().value).toBe("apricot");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("chooses an option on click and keeps focus in the input", async () => {
    render(<Fruits />);
    await userEvent.type(input(), "ap");
    await userEvent.click(screen.getByRole("option", { name: "apple" }));
    expect(input().value).toBe("apple");
    expect(document.activeElement).toBe(input());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays open after choosing when closeOnSelect is false", async () => {
    render(<Fruits closeOnSelect={false} />);
    await userEvent.type(input(), "ap");
    await userEvent.click(screen.getByRole("option", { name: "apple" }));
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["apple"]);
  });

  it("closes on Escape without changing the text, and reopens on ArrowDown", async () => {
    render(<Fruits />);
    await userEvent.type(input(), "ap");
    await userEvent.keyboard("{Escape}");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().value).toBe("ap");
    await userEvent.keyboard("{ArrowDown}");
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves on Tab without choosing", async () => {
    render(<Fruits />);
    await userEvent.type(input(), "ap{ArrowDown}");
    await userEvent.tab();
    expect(input().value).toBe("ap");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("lets Enter submit the form when no option is active", async () => {
    const onSubmit = vi.fn<(event: React.FormEvent) => void>((event) => event.preventDefault());
    const onSelect = vi.fn<(value: string) => void>();
    render(
      <form onSubmit={onSubmit}>
        <Combobox label="Fruit" value="ap" onChange={() => undefined} options={fruits} onSelect={onSelect} />
      </form>,
    );
    await userEvent.type(input(), "{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("allows any text, with no options at all", async () => {
    render(<Fruits />);
    await userEvent.type(input(), "cherry");
    expect(input().value).toBe("cherry");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a loading row while loading", async () => {
    render(
      <Combobox
        label="Fruit"
        value=""
        onChange={() => undefined}
        options={[]}
        onSelect={() => undefined}
        loading
        loadingLabel="Loading fruit…"
      />,
    );
    await userEvent.click(input());
    await userEvent.keyboard("{ArrowDown}");
    expect(listbox().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading fruit…")).toBeTruthy();
  });

  it("shows an error like an Input", () => {
    render(<Combobox label="Fruit" value="" onChange={() => undefined} options={[]} onSelect={() => undefined} error="Not a fruit" />);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Not a fruit").id).toBe(input().getAttribute("aria-describedby"));
  });
});
