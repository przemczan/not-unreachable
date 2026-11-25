// Copies the built web app (apps/web/dist) to dist/web, where dist/main.js serves it from.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const target = fileURLToPath(new URL("../dist/web/", import.meta.url));

if (!existsSync(`${source}index.html`)) {
  console.error(`copy-web: ${source}index.html is missing. Build the web app first (pnpm -r build builds it before the server).`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copy-web: copied ${source} to ${target}`);
