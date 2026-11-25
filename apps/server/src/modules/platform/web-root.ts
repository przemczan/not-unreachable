import { statSync } from "node:fs";
import { join } from "node:path";

/** Thrown at startup when the built web app is missing. */
export class WebRootError extends Error {
  override readonly name = "WebRootError";
}

/** Checks that `directory` holds the built SPA (its `index.html`), so a broken build fails at startup, not per request. */
export function checkWebRoot(directory: string): void {
  const index = join(directory, "index.html");
  if (!statSync(index, { throwIfNoEntry: false })?.isFile()) {
    throw new WebRootError(`The web app is missing: ${index} does not exist (build it with pnpm build)`);
  }
}
