import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, initialsOf, paletteIndexOf } from "./Avatar.tsx";

describe("Avatar", () => {
  it("shows the initials and is an image named by the full name", () => {
    render(<Avatar name="Marta Kowalska" />);
    const avatar = screen.getByRole("img", { name: "Marta Kowalska" });
    expect(avatar.textContent).toBe("MK");
    expect(avatar.classList).toContain("size-8");
  });

  it("takes at most two initials", () => {
    expect(initialsOf("  jan maria  nowak ")).toBe("JM");
    expect(initialsOf("")).toBe("");
  });

  it("derives the same colour from the same name, from the token palette", () => {
    const { unmount } = render(<Avatar name="Jan Nowak" />);
    const first = screen.getByRole("img").className;
    unmount();
    render(<Avatar name="Jan Nowak" />);
    expect(screen.getByRole("img").className).toBe(first);
    expect(first).toMatch(/bg-(info|success|warning|accent|neutral|danger)-subtle/);
    expect(paletteIndexOf("Jan Nowak")).toBe(paletteIndexOf("Jan Nowak"));
  });

  it("spreads different names over the palette", () => {
    const names = ["Ada", "Bob", "Cy", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy", "Jo"];
    expect(new Set(names.map(paletteIndexOf)).size).toBeGreaterThan(1);
  });

  it("shows the image instead of initials when given src", () => {
    render(<Avatar name="Jan Nowak" src="/avatars/jan.png" size="xl" />);
    const avatar = screen.getByRole("img", { name: "Jan Nowak" });
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe("/avatars/jan.png");
    expect(avatar.textContent).toBe("");
    expect(avatar.classList).toContain("size-14");
  });

  it("is decorative without a name", () => {
    const { container } = render(<Avatar size="xs" />);
    const avatar = container.firstElementChild;
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.classList).toContain("size-5");
  });
});
