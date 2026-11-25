import { describe, expect, it } from "vitest";
import { findUnknownClasses, noUnknownClasses } from "./no-unknown-classes.ts";
import { testRule } from "./rule-tester.ts";
import { generatesCss } from "./tailwind.ts";

describe("generatesCss (Tailwind with theme.css)", () => {
  it.each(["text-gray-500", "shadow-lg", "rounded-xl", "foo", "hover:text-gray-500"])("rejects %s", (candidate) => {
    expect(generatesCss(candidate)).toBe(false);
  });

  it.each([
    "flex",
    "p-1.5",
    "text-fg-1",
    "bg-surface",
    "hover:bg-accent",
    "dark:bg-surface",
    "data-[state=open]:bg-surface",
    "left-(--nu-menu-x)",
    "type-body",
    "z-modal",
    "rounded-control",
    "group",
    "peer/row",
    "group-hover:text-fg-1",
  ])("accepts %s", (candidate) => {
    expect(generatesCss(candidate)).toBe(true);
  });

  it("finds the unknown classes of a list", () => {
    expect(findUnknownClasses("flex text-gray-500  gap-2 shadow-lg")).toEqual(["text-gray-500", "shadow-lg"]);
  });
});

testRule("no-unknown-classes", noUnknownClasses, {
  valid: [
    `<div className="flex gap-2 p-1.5 text-fg-1 hover:bg-accent" />`,
    `<div className="group"><span className="group-hover:text-fg-2" /></div>`,
    "<div className={`flex ${open ? 'bg-surface' : ''} gap-${n} p-${n}x`} />",
    `const c = cn("flex", on && "bg-surface", { "text-fg-2": muted }, className);`,
    `const v = cva("flex", { variants: { size: { sm: "h-8" } }, compoundVariants: [{ size: "sm", class: "p-2" }], defaultVariants: { size: "sm" } });`,
    `const label = "text-gray-500"; // not a class list`,
    `<div className="" />`,
  ],
  invalid: [
    { code: `<div className="text-gray-500 flex" />`, errors: ['"text-gray-500"'] },
    { code: `<div className="shadow-lg rounded-xl" />`, errors: ['"shadow-lg"', '"rounded-xl"'] },
    { code: "<div className={`flex shadow-lg ${x}`} />", errors: ['"shadow-lg"'] },
    { code: "<div className={`flex ${on ? 'rounded-xl' : 'p-2'}`} />", errors: ['"rounded-xl"'] },
    { code: `const c = cn("flex", on && "hover:text-gray-500");`, errors: ['"hover:text-gray-500"'] },
    { code: `const v = cva("rounded-xl", { variants: { tone: { a: "text-gray-500" } } });`, errors: ['"rounded-xl"', '"text-gray-500"'] },
    { code: `<Card bodyClassName="foo" />`, errors: ['"foo"'] },
  ],
});
