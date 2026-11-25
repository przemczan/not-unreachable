import { is, type JSXOpeningElement, type Rule } from "./ast.ts";

export const noStyleElement: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow <style> elements in JSX: the CSP blocks them, and styles belong in the design system." },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node: JSXOpeningElement) {
        if (is(node.name, "JSXIdentifier") && node.name.name === "style") {
          context.report({
            node,
            message:
              "<style> element: the CSP blocks inline styles. Style through the design system's classes, or add the style to the design system.",
          });
        }
      },
    };
  },
};
