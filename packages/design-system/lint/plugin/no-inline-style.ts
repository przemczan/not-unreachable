import { is, unwrap, type AstNode, type JSXAttribute, type Rule } from "./ast.ts";

/** Whether a `style` value only sets CSS custom properties: `{{ "--progress": pct }}`. */
export function isCustomPropertiesOnly(value: AstNode | null): boolean {
  const object = is(value, "JSXExpressionContainer") ? unwrap(value.expression) : null;
  if (!is(object, "ObjectExpression")) {
    return false;
  }
  return object.properties.every(
    (property) =>
      is(property, "Property") &&
      is(property.key, "Literal") &&
      typeof property.key.value === "string" &&
      property.key.value.startsWith("--"),
  );
}

export const noInlineStyle: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow the style prop, except an object literal that only sets CSS custom properties." },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node: JSXAttribute) {
        if (is(node.name, "JSXIdentifier") && node.name.name === "style" && !isCustomPropertiesOnly(node.value)) {
          context.report({
            node,
            message:
              'Inline style: style through the design system\'s classes. Only CSS custom properties may be set inline, as an object literal: style={{ "--progress": pct }}.',
          });
        }
      },
    };
  },
};
