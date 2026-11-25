import { noArbitraryValues } from "./no-arbitrary-values.ts";
import { noInlineStyle } from "./no-inline-style.ts";
import { noRawStyleValues } from "./no-raw-style-values.ts";
import { noStyleElement } from "./no-style-element.ts";
import { noUnknownClasses } from "./no-unknown-classes.ts";

/**
 * The nu-design-system lint plugin: keeps screens on the design system's tokens and classes
 * (docs/design/design-system.md, Enforcement). An oxlint JS plugin written to the ESLint rule API,
 * enabled by ../adherence.oxlintrc.json.
 */
const plugin = {
  meta: { name: "nu-design-system" },
  rules: {
    "no-arbitrary-values": noArbitraryValues,
    "no-raw-style-values": noRawStyleValues,
    "no-inline-style": noInlineStyle,
    "no-style-element": noStyleElement,
    "no-unknown-classes": noUnknownClasses,
  },
};

export default plugin;
