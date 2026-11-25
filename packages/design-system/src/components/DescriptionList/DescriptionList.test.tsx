import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DescriptionList, type DescriptionItem } from "./DescriptionList.tsx";

const items: DescriptionItem[] = [
  { label: "Event", value: "session.signed_out", mono: true },
  { label: "Event ID", value: "evt_10482", mono: true, copyable: true },
  { label: "Actor", value: "Ada Lovelace" },
  { label: "IP address" },
];

describe("DescriptionList", () => {
  it("pairs each term with its description, an em dash for no value", () => {
    const { container } = render(<DescriptionList items={items} />);
    const terms = Array.from(container.querySelectorAll("dt")).map((term) => term.textContent);
    const values = Array.from(container.querySelectorAll("dd")).map((value) => value.textContent);
    expect(terms).toEqual(["Event", "Event ID", "Actor", "IP address"]);
    expect(values).toEqual(["session.signed_out", "evt_10482", "Ada Lovelace", "—"]);
  });

  it("sets mono values in Geist Mono", () => {
    render(<DescriptionList items={items} />);
    expect(screen.getByText("session.signed_out").classList).toContain("type-mono");
    expect(screen.getByText("Ada Lovelace").classList).toContain("type-body");
  });

  it("sets the label width through a custom property in the inline layout", () => {
    const { container } = render(<DescriptionList items={items} labelWidth={96} />);
    expect(container.querySelector("dl")?.getAttribute("style")).toBe("--nu-dl-label: 96px;");
    expect(container.querySelector("dt")?.classList).toContain("w-(--nu-dl-label)");
  });

  it("puts labels above values when stacked, in columns", () => {
    const { container } = render(<DescriptionList items={items} layout="stacked" columns={2} />);
    expect(container.querySelector("dl")?.classList).toContain("grid-cols-2");
    expect(container.querySelector("dl")?.hasAttribute("style")).toBe(false);
    expect(container.querySelector("dt")?.classList).toContain("type-caption");
  });

  it("copies a copyable value and confirms it", async () => {
    const user = userEvent.setup();
    render(<DescriptionList items={items} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe("evt_10482");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("copies the given string when copyable is one", async () => {
    const user = userEvent.setup();
    render(<DescriptionList items={[{ label: "Target", value: "Ada's file", copyable: "fil_42" }]} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe("fil_42");
  });
});
