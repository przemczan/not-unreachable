import type { CallExpression, JSXAttribute } from "./ast.ts";
import { segmentsOfCall, segmentsOfJsxAttribute, type ClassSegment } from "./class-strings.ts";

/** The visitor of a rule that checks class lists: it is handed every class segment of `className` and of `cn()` & co. */
export function classListVisitors(check: (segment: ClassSegment) => void) {
  return {
    JSXAttribute(node: JSXAttribute) {
      segmentsOfJsxAttribute(node).forEach(check);
    },
    CallExpression(node: CallExpression) {
      segmentsOfCall(node).forEach(check);
    },
  };
}

/**
 * Splits a Tailwind candidate into its variants and its utility at the colons outside brackets and
 * parentheses: `data-[state=open]:hover:w-4` → `["data-[state=open]", "hover"]`, `"w-4"`.
 */
export function splitVariants(candidate: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < candidate.length; index++) {
    const char = candidate[index];
    if (char === "[" || char === "(") {
      depth++;
    } else if ((char === "]" || char === ")") && depth > 0) {
      depth--;
    } else if (char === ":" && depth === 0) {
      parts.push(candidate.slice(start, index));
      start = index + 1;
    }
  }
  return { variants: parts, utility: candidate.slice(start) };
}
