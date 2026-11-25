import type { Rule } from "./ast.ts";
import { allTokens } from "./class-strings.ts";
import { classListVisitors, splitVariants } from "./class-visitors.ts";

/**
 * Whether a class uses a Tailwind arbitrary value or property: `w-[13px]`, `bg-[#0af]`,
 * `font-['Inter']`, `[mask-type:luminance]`, also behind variants (`hover:w-[3px]`). Arbitrary
 * variants (`data-[state=open]:`) and the `(--var)` shorthand (`left-(--nu-menu-x)`) are allowed:
 * they hold no raw value.
 */
export function isArbitrary(candidate: string): boolean {
  return splitVariants(candidate).utility.includes("[");
}

/** The classes of a class list that use arbitrary values; a class cut by a template expression counts too. */
export function findArbitraryValues(classList: string): string[] {
  return classList
    .split(/\s+/)
    .filter((token) => token !== "")
    .filter(isArbitrary);
}

export const noArbitraryValues: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow Tailwind arbitrary values and properties in class lists: use the theme's classes." },
    schema: [],
  },
  create(context) {
    return classListVisitors((segment) => {
      for (const token of allTokens(segment).filter(isArbitrary)) {
        context.report({
          node: segment.node,
          message: `"${token}" uses a Tailwind arbitrary value. Use a class of the design system's theme, or add a token (docs/design/design-system.md, Enforcement).`,
        });
      }
    });
  },
};
