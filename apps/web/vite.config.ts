import { createRequire } from "node:module";
import { relative, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";

const brandSpecifier = /\bhref="(@not-unreachable\/design-system\/brand\/[\w.-]+)"/g;

/**
 * Lets `index.html` link the design system's brand files (favicon, Apple touch icon) by their
 * package export, `@not-unreachable/design-system/brand/…`, which Vite doesn't resolve in HTML. The
 * build gets a path it bundles as a hashed same-origin asset; the dev server gets an `/@fs/` URL.
 */
function brandIcons(): Plugin {
  const require = createRequire(import.meta.url);
  let serve = false;
  let root = "";
  return {
    name: "nu-brand-icons",
    configResolved(config) {
      serve = config.command === "serve";
      root = config.root;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replaceAll(brandSpecifier, (_match, specifier: string) => {
          const file = require.resolve(specifier);
          const url = serve ? `/@fs/${file.split(sep).join("/").replace(/^\//, "")}` : relative(root, file).split(sep).join("/");
          return `href="${url}"`;
        });
      },
    },
  };
}

/**
 * The build must make the CSP in threat-model.md (T4) possible: no inline script or style in
 * `index.html`, no `data:` script URLs and nothing that assigns HTML strings to script sinks.
 * The fonts come from the design system's theme.css as hashed files of the build, served from the
 * app's own origin (`font-src 'self'`).
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), brandIcons()],
  resolve: {
    conditions: ["@not-unreachable/source", ...defaultClientConditions],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8480",
    },
  },
  build: {
    target: "es2024",
    // The polyfill is an inline script; every browser we support has module preload.
    modulePreload: { polyfill: false },
    // Every asset is a file of its own, never a data: URL inlined into JS or CSS.
    assetsInlineLimit: 0,
    sourcemap: false,
    rolldownOptions: {
      // Modules run in their import order across chunks too, so src/zod-config.ts configures zod
      // before the contracts build their schemas.
      output: { strictExecutionOrder: true },
    },
  },
});
