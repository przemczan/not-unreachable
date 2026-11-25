import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** `apps/server/package.json`, the same depth from `src/modules/platform/` and `dist/modules/platform/`. */
const packageFile = fileURLToPath(new URL("../../../package.json", import.meta.url));

const packageSchema = z.looseObject({ version: z.string().min(1) });

/** The server's version from its package.json; "unknown" when it can't be read. */
export function serverVersion(file: string = packageFile): string {
  try {
    return packageSchema.parse(JSON.parse(readFileSync(file, "utf8"))).version;
  } catch {
    return "unknown";
  }
}
