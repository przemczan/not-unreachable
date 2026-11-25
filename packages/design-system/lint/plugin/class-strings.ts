import { is, unwrap, type AstNode, type CallExpression, type JSXAttribute } from "./ast.ts";

/**
 * A piece of class-list text found in the code: a string literal, or one static part of a
 * template literal or a `+` concatenation. `openStart` / `openEnd` say that an expression is glued
 * to that side, so the token touching it is only part of a class name.
 */
export interface ClassSegment {
  readonly node: AstNode;
  readonly text: string;
  readonly openStart: boolean;
  readonly openEnd: boolean;
}

/** The functions whose string arguments are class lists. */
export const CLASS_FUNCTIONS: ReadonlySet<string> = new Set(["cn", "clsx", "cva", "twMerge", "twJoin"]);

const CLASS_ATTRIBUTE = /^(?:class|className|[A-Za-z]+ClassName)$/;

/** The class segments of a JSX `className` (or `class`, `…ClassName`) attribute; none for other attributes. */
export function segmentsOfJsxAttribute(attribute: JSXAttribute): ClassSegment[] {
  if (!is(attribute.name, "JSXIdentifier") || !CLASS_ATTRIBUTE.test(attribute.name.name) || attribute.value === null) {
    return [];
  }
  const out: ClassSegment[] = [];
  collect(attribute.value, out, false, false);
  return out;
}

/** The class segments of a `cn()` / `clsx()` / `cva()` / `twMerge()` / `twJoin()` call; none for other calls. */
export function segmentsOfCall(call: CallExpression): ClassSegment[] {
  if (!is(call.callee, "Identifier") || !CLASS_FUNCTIONS.has(call.callee.name)) {
    return [];
  }
  const out: ClassSegment[] = [];
  if (call.callee.name === "cva") {
    const [base, config] = call.arguments;
    if (base !== undefined) {
      collect(base, out, false, false);
    }
    if (is(config, "ObjectExpression")) {
      collectCvaConfig(config.properties, out);
    }
    return out;
  }
  for (const argument of call.arguments) {
    collect(argument, out, false, false);
  }
  return out;
}

function propertyName(node: AstNode): string | null {
  if (!is(node, "Property") || node.computed) {
    return null;
  }
  if (is(node.key, "Identifier")) {
    return node.key.name;
  }
  return is(node.key, "Literal") && typeof node.key.value === "string" ? node.key.value : null;
}

/** `variants: { name: { option: classes } }` and `compoundVariants: [{ …, class: classes }]`; `defaultVariants` holds option names, not classes. */
function collectCvaConfig(properties: readonly AstNode[], out: ClassSegment[]): void {
  for (const property of properties) {
    if (!is(property, "Property")) {
      continue;
    }
    const name = propertyName(property);
    if (name === "variants" && is(property.value, "ObjectExpression")) {
      for (const variant of property.value.properties) {
        if (is(variant, "Property") && is(variant.value, "ObjectExpression")) {
          for (const option of variant.value.properties) {
            if (is(option, "Property")) {
              collect(option.value, out, false, false);
            }
          }
        }
      }
    } else if (name === "compoundVariants" && is(property.value, "ArrayExpression")) {
      for (const compound of property.value.elements) {
        if (is(compound, "ObjectExpression")) {
          for (const entry of compound.properties) {
            const entryName = is(entry, "Property") ? propertyName(entry) : null;
            if (is(entry, "Property") && (entryName === "class" || entryName === "className")) {
              collect(entry.value, out, false, false);
            }
          }
        }
      }
    }
  }
}

/**
 * Whether a template expression is glued to the quasi on one side: no whitespace between them. An
 * empty quasi at the template's edge glues it to whatever is glued to the template itself.
 */
function glued(quasi: string, atEdge: boolean, outerOpen: boolean, whitespace: RegExp): boolean {
  return quasi === "" && atEdge ? outerOpen : !whitespace.test(quasi);
}

function collect(wrapped: AstNode | null | undefined, out: ClassSegment[], openStart: boolean, openEnd: boolean): void {
  const node = unwrap(wrapped);
  if (node === null || node === undefined) {
    return;
  }
  if (is(node, "Literal")) {
    if (typeof node.value === "string") {
      out.push({ node, text: node.value, openStart, openEnd });
    }
  } else if (is(node, "TemplateLiteral")) {
    const texts = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
    const last = node.quasis.length - 1;
    node.quasis.forEach((quasi, index) => {
      out.push({ node: quasi, text: texts[index] ?? "", openStart: openStart || index > 0, openEnd: openEnd || index < last });
    });
    // `${open ? "a" : "b"}`: the strings inside are whole classes only where whitespace separates them from the quasis.
    node.expressions.forEach((expression, index) => {
      const before = texts[index] ?? "";
      const after = texts[index + 1] ?? "";
      collect(expression, out, glued(before, index === 0, openStart, /\s$/), glued(after, index + 1 === last, openEnd, /^\s/));
    });
  } else if (is(node, "JSXExpressionContainer")) {
    collect(node.expression, out, openStart, openEnd);
  } else if (is(node, "ArrayExpression")) {
    for (const element of node.elements) {
      collect(element, out, false, false);
    }
  } else if (is(node, "ObjectExpression")) {
    // clsx's object form: the keys are the class names, the values are conditions.
    for (const property of node.properties) {
      if (is(property, "Property") && !property.computed) {
        if (is(property.key, "Literal")) {
          collect(property.key, out, false, false);
        } else if (is(property.key, "Identifier")) {
          out.push({ node: property.key, text: property.key.name, openStart: false, openEnd: false });
        }
      }
    }
  } else if (is(node, "LogicalExpression")) {
    // `cond && "a"`: the left side is a condition; `a || "b"` / `a ?? "b"`: both sides can be classes.
    if (node.operator !== "&&") {
      collect(node.left, out, openStart, openEnd);
    }
    collect(node.right, out, openStart, openEnd);
  } else if (is(node, "ConditionalExpression")) {
    collect(node.consequent, out, openStart, openEnd);
    collect(node.alternate, out, openStart, openEnd);
  } else if (is(node, "BinaryExpression") && node.operator === "+") {
    collect(node.left, out, openStart, true);
    collect(node.right, out, true, openEnd);
  }
}

/** Every whitespace-separated token of the segment, including those cut by an expression. */
export function allTokens(segment: ClassSegment): string[] {
  return segment.text.split(/\s+/).filter((token) => token !== "");
}

/** Only the whole class names of the segment: tokens glued to an expression are left out. */
export function completeTokens(segment: ClassSegment): string[] {
  const parts = segment.text.split(/\s+/);
  // split() leaves "" at an end that is whitespace, so the first/last part is cut only when it is non-empty.
  if (segment.openStart) {
    parts[0] = "";
  }
  if (segment.openEnd) {
    parts[parts.length - 1] = "";
  }
  return parts.filter((token) => token !== "");
}
