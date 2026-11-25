import { noStyleElement } from "./no-style-element.ts";
import { testRule } from "./rule-tester.ts";

const message = "<style> element";

testRule("no-style-element", noStyleElement, {
  valid: [`<div className="p-2" />`, `<Style />`, `<svg><title>style</title></svg>`, `const style = "x";`],
  invalid: [
    { code: `<style>{"@keyframes spin { to { rotate: 1turn; } }"}</style>`, errors: [message] },
    { code: `<div><style /></div>`, errors: [message] },
  ],
});
