import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import type { Rule } from "./ast.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { sourceType: "module", parserOptions: { lang: "tsx" } } });

function containing(fragment: string): RegExp {
  return new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/**
 * Runs oxlint's RuleTester (the ESLint RuleTester API) on one of the plugin's rules, as TSX, in
 * vitest. Each expected error is a fragment of its message, such as the class it names.
 */
export function testRule(name: string, rule: Rule, tests: { valid: string[]; invalid: { code: string; errors: string[] }[] }): void {
  tester.run(name, rule, {
    valid: tests.valid,
    invalid: tests.invalid.map(({ code, errors }) => ({ code, errors: errors.map((fragment) => ({ message: containing(fragment) })) })),
  });
}
