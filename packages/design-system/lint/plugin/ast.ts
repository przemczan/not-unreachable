/**
 * The slice of the ESTree AST (as oxlint's JS plugins and ESLint hand it over) and of the ESLint
 * rule API that the nu-design-system rules use. oxlint doesn't export its AST types, so they are
 * written out here, loosely: only the fields the rules read.
 */

export interface AstNode {
  readonly type: string;
  readonly range: [number, number];
  readonly parent?: AstNode | null;
}

export interface Literal extends AstNode {
  readonly type: "Literal";
  readonly value: unknown;
}

export interface TemplateElement extends AstNode {
  readonly type: "TemplateElement";
  readonly value: { readonly raw: string; readonly cooked: string | null };
}

export interface TemplateLiteral extends AstNode {
  readonly type: "TemplateLiteral";
  readonly quasis: readonly TemplateElement[];
  readonly expressions: readonly AstNode[];
}

export interface Identifier extends AstNode {
  readonly type: "Identifier";
  readonly name: string;
}

export interface ArrayExpression extends AstNode {
  readonly type: "ArrayExpression";
  readonly elements: readonly (AstNode | null)[];
}

export interface ObjectExpression extends AstNode {
  readonly type: "ObjectExpression";
  readonly properties: readonly AstNode[];
}

export interface Property extends AstNode {
  readonly type: "Property";
  readonly key: AstNode;
  readonly value: AstNode;
  readonly computed: boolean;
}

export interface CallExpression extends AstNode {
  readonly type: "CallExpression";
  readonly callee: AstNode;
  readonly arguments: readonly AstNode[];
}

export interface LogicalExpression extends AstNode {
  readonly type: "LogicalExpression";
  readonly operator: "&&" | "||" | "??";
  readonly left: AstNode;
  readonly right: AstNode;
}

export interface ConditionalExpression extends AstNode {
  readonly type: "ConditionalExpression";
  readonly consequent: AstNode;
  readonly alternate: AstNode;
}

export interface BinaryExpression extends AstNode {
  readonly type: "BinaryExpression";
  readonly operator: string;
  readonly left: AstNode;
  readonly right: AstNode;
}

export interface JSXIdentifier extends AstNode {
  readonly type: "JSXIdentifier";
  readonly name: string;
}

export interface JSXAttribute extends AstNode {
  readonly type: "JSXAttribute";
  readonly name: AstNode;
  readonly value: AstNode | null;
}

export interface JSXExpressionContainer extends AstNode {
  readonly type: "JSXExpressionContainer";
  readonly expression: AstNode;
}

export interface JSXOpeningElement extends AstNode {
  readonly type: "JSXOpeningElement";
  readonly name: AstNode;
}

interface NodeTypes {
  Literal: Literal;
  TemplateElement: TemplateElement;
  TemplateLiteral: TemplateLiteral;
  Identifier: Identifier;
  ArrayExpression: ArrayExpression;
  ObjectExpression: ObjectExpression;
  Property: Property;
  CallExpression: CallExpression;
  LogicalExpression: LogicalExpression;
  ConditionalExpression: ConditionalExpression;
  BinaryExpression: BinaryExpression;
  JSXIdentifier: JSXIdentifier;
  JSXAttribute: JSXAttribute;
  JSXExpressionContainer: JSXExpressionContainer;
  JSXOpeningElement: JSXOpeningElement;
}

export function is<K extends keyof NodeTypes>(node: AstNode | null | undefined, type: K): node is NodeTypes[K] {
  return node?.type === type;
}

const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);

/** The expression inside `x as T`, `x satisfies T`, `x!` and `(x)`, which change nothing at run time. */
export function unwrap(node: AstNode | null | undefined): AstNode | null | undefined {
  let current = node;
  while (current !== null && current !== undefined && TRANSPARENT_WRAPPERS.has(current.type) && hasExpression(current)) {
    current = current.expression;
  }
  return current;
}

function hasExpression(node: AstNode): node is AstNode & { readonly expression: AstNode } {
  return "expression" in node && typeof node.expression === "object" && node.expression !== null;
}

export interface RuleContext {
  report(this: void, descriptor: { node: AstNode; message: string }): void;
}

export interface Rule {
  readonly meta: {
    readonly type: "problem" | "suggestion";
    readonly docs: { readonly description: string };
    readonly schema: readonly [];
  };
  create(context: RuleContext): Record<string, (node: never) => void>;
}
