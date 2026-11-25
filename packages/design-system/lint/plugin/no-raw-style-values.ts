import { is, type AstNode, type Literal, type Property, type Rule, type TemplateLiteral } from "./ast.ts";

const UNITS = "px|rem|em|vh|vw|dvh|svh|lvh|dvw|svw|lvw|vmin|vmax|ch|ex|pt|pc|cqw|cqh";

/** `#fff`, `#0af8`, `#00aaff`, `#00aaff80`; not `&#123;` nor a longer word such as `#section`. */
const HEX_COLOUR = /(?<![\w&#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/gi;
/** A number glued to a unit: `8px`, `-0.5rem`, `2em`, `100vh`; not `p-1.5`, `item`, `max-w-95`. */
const LENGTH = new RegExp(String.raw`(?<![\w.])-?(?:\d+(?:\.\d+)?|\.\d+)(?:${UNITS})(?![\w-])`, "gi");
/** A unit right after a template expression: the `px` of `` `0 ${x}px` ``. */
const UNIT_AFTER_EXPRESSION = new RegExp(String.raw`^(?:${UNITS})(?![\w-])`, "i");
const FONT_FAMILY_DECLARATION = /font-family\s*:\s*([^;}]+)/gi;
const FONT_ARBITRARY_CLASS = /\bfont-\[([^\]]+)\]/gi;

const ALLOWED_FONTS: ReadonlySet<string> = new Set(["geist", "geist mono"]);
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

/** The font names of a `font-family` list other than Geist and Geist Mono; generic families and `var()` are fine. */
export function foreignFontNames(familyList: string): string[] {
  return familyList
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, ""))
    .filter((family) => family !== "" && !family.startsWith("var(") && !GENERIC_FAMILIES.has(family.toLowerCase()))
    .filter((family) => !ALLOWED_FONTS.has(family.toLowerCase()));
}

/**
 * The raw style values in a piece of string text: hex colours, colour functions, lengths with a
 * unit and font families other than Geist / Geist Mono. `afterExpression` says the text follows a
 * template expression, so a unit at its very start is a length too (`` `${x}px` ``).
 */
export function findRawStyleValues(text: string, afterExpression = false): string[] {
  const found: string[] = [];
  if (afterExpression) {
    const unit = UNIT_AFTER_EXPRESSION.exec(text);
    if (unit !== null) {
      found.push(`\${…}${unit[0]}`);
    }
  }
  for (const pattern of [HEX_COLOUR, COLOUR_FUNCTION, LENGTH]) {
    for (const match of text.matchAll(pattern)) {
      found.push(match[0]);
    }
  }
  for (const match of text.matchAll(FONT_FAMILY_DECLARATION)) {
    found.push(...foreignFontNames(match[1] ?? ""));
  }
  for (const match of text.matchAll(FONT_ARBITRARY_CLASS)) {
    const value = (match[1] ?? "").replace(/^family-name:/, "").replaceAll("_", " ");
    if (!/^\d+$/.test(value)) {
      found.push(...foreignFontNames(value));
    }
  }
  return found;
}

/** Module specifiers are paths, not style values. */
const SPECIFIER_PARENTS: ReadonlySet<string> = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "ImportAttribute",
  "TSExternalModuleReference",
  "TSImportType",
]);

function isSpecifier(node: AstNode): boolean {
  const parent = node.parent;
  return parent !== null && parent !== undefined && (SPECIFIER_PARENTS.has(parent.type) || parent.parent?.type === "TSImportType");
}

const FONT_FAMILY_KEYS: ReadonlySet<string> = new Set(["fontFamily", "font-family"]);

function message(value: string): string {
  return `Raw style value "${value}": raw values live only in tokens.json and the generated CSS. Use the design system's classes or a token via var() (docs/design/design-system.md, Enforcement).`;
}

export const noRawStyleValues: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow hex colours, colour functions, lengths with units and foreign font families in strings." },
    schema: [],
  },
  create(context) {
    return {
      Literal(node: Literal) {
        if (typeof node.value !== "string" || isSpecifier(node)) {
          return;
        }
        for (const value of findRawStyleValues(node.value)) {
          context.report({ node, message: message(value) });
        }
      },
      TemplateLiteral(node: TemplateLiteral) {
        node.quasis.forEach((quasi, index) => {
          for (const value of findRawStyleValues(quasi.value.cooked ?? quasi.value.raw, index > 0)) {
            context.report({ node: quasi, message: message(value) });
          }
        });
      },
      Property(node: Property) {
        const key = is(node.key, "Identifier") ? node.key.name : is(node.key, "Literal") ? node.key.value : null;
        if (typeof key === "string" && FONT_FAMILY_KEYS.has(key) && is(node.value, "Literal") && typeof node.value.value === "string") {
          for (const font of foreignFontNames(node.value.value)) {
            context.report({ node: node.value, message: message(font) });
          }
        }
      },
    };
  },
};
