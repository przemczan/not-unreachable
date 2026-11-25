import type { Rule } from "./ast.ts";
import { completeTokens } from "./class-strings.ts";
import { classListVisitors } from "./class-visitors.ts";
import { generatesCss } from "./tailwind.ts";

/** The classes of a class list that Tailwind doesn't generate from our theme. */
export function findUnknownClasses(classList: string): string[] {
  return classList
    .split(/\s+/)
    .filter((token) => token !== "")
    .filter((token) => !generatesCss(token));
}

export const noUnknownClasses: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow class names that Tailwind doesn't generate from the design system's theme.css." },
    schema: [],
  },
  create(context) {
    return classListVisitors((segment) => {
      for (const token of completeTokens(segment)) {
        if (!generatesCss(token)) {
          context.report({
            node: segment.node,
            message: `"${token}" is not a class of the design system's theme: Tailwind generates no CSS for it (the default palette, shadows and radii are reset). See packages/design-system/README.md for the theme's classes.`,
          });
        }
      }
    });
  },
};
