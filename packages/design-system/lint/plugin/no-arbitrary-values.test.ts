import { describe, expect, it } from "vitest";
import { findArbitraryValues, isArbitrary, noArbitraryValues } from "./no-arbitrary-values.ts";
import { testRule } from "./rule-tester.ts";

describe("isArbitrary", () => {
  it.each([
    "w-[13px]",
    "bg-[#0af]",
    "text-[15px]",
    "font-['Inter']",
    "[mask-type:luminance]",
    "hover:w-[3px]",
    "md:hover:grid-cols-[1fr_2fr]",
    "bg-accent/[0.5]",
  ])("rejects %s", (candidate) => {
    expect(isArbitrary(candidate)).toBe(true);
  });

  it.each([
    "w-4",
    "p-1.5",
    "left-(--nu-menu-x)",
    "data-[state=open]:bg-surface",
    "aria-[sort=ascending]:text-fg-1",
    "group-hover:text-fg-1",
    "max-w-95",
  ])("accepts %s", (candidate) => {
    expect(isArbitrary(candidate)).toBe(false);
  });

  it("finds the arbitrary classes of a list", () => {
    expect(findArbitraryValues("flex w-[13px]  gap-2 [mask-type:luminance]")).toEqual(["w-[13px]", "[mask-type:luminance]"]);
  });
});

testRule("no-arbitrary-values", noArbitraryValues, {
  valid: [
    `<div className="flex gap-2 p-1.5 text-fg-1" />`,
    `<div className="left-(--nu-menu-x) data-[state=open]:bg-surface" />`,
    `const c = cn("w-4", ok && "bg-surface", { "text-fg-2": muted });`,
    `const label = "w-[13px]"; // not a class list`,
    `const v = cva("flex", { variants: { size: { sm: "h-8", md: ["h-9", "px-3"] } }, defaultVariants: { size: "sm" } });`,
    `<div title="w-[13px]" />`,
  ],
  invalid: [
    { code: `<div className="w-[13px] flex" />`, errors: ['"w-[13px]"'] },
    { code: `<div className="hover:w-[3px]" />`, errors: ['"hover:w-[3px]"'] },
    { code: `<div className={"[mask-type:luminance]"} />`, errors: ['"[mask-type:luminance]"'] },
    { code: "<div className={`flex font-['Inter'] ${x}`} />", errors: ["\"font-['Inter']\""] },
    { code: "<div className={`w-[${size}px]`} />", errors: ['"w-["'] },
    { code: `const c = cn("flex", open && "bg-[#0af]");`, errors: ['"bg-[#0af]"'] },
    { code: `const c = clsx(["text-[15px]"], { "w-[2px]": on });`, errors: ['"text-[15px]"', '"w-[2px]"'] },
    {
      code: `const v = cva("p-[3px]", { variants: { tone: { a: "bg-[#fff]", b: ["text-[9px]"] } }, compoundVariants: [{ tone: "a", class: "m-[1px]" }] });`,
      errors: ['"p-[3px]"', '"bg-[#fff]"', '"text-[9px]"', '"m-[1px]"'],
    },
    { code: `<Icon iconClassName="size-[13px]" />`, errors: ['"size-[13px]"'] },
  ],
});
