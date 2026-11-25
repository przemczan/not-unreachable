import { noInlineStyle } from "./no-inline-style.ts";
import { testRule } from "./rule-tester.ts";

const message = "Inline style";

testRule("no-inline-style", noInlineStyle, {
  valid: [
    `<div style={{ "--progress": pct }} />`,
    `<div style={{ "--x": a, "--y": b } as React.CSSProperties} />`,
    `<div style={{ "--x": a } satisfies Record<string, string>} />`,
    `<div className="p-2" />`,
    `<div data-style="x" />`,
    `<div style={{ ["--x"]: 1 }} />`,
  ],
  invalid: [
    { code: `<div style={{ marginTop: 8 }} />`, errors: [message] },
    { code: `<div style={{ "--progress": pct, color: "red" }} />`, errors: [message] },
    { code: `<div style={styles} />`, errors: [message] },
    { code: `<div style={{ ...vars }} />`, errors: [message] },
    { code: `<div style="color: red" />`, errors: [message] },
    { code: `<Card style={{ padding: 0 }} />`, errors: [message] },
  ],
});
