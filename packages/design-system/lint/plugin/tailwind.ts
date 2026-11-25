import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";

/**
 * Tailwind's own compiler, loaded once per lint process with the package's generated theme.css,
 * so "does this class exist" never drifts from the theme. Loaded with top-level await when the
 * plugin is imported, as lint rules run synchronously.
 */
const themePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/theme.css");
const designSystem = await __unstable__loadDesignSystem(await readFile(themePath, "utf8"), { base: path.dirname(themePath) });

const known = new Map<string, boolean>();

/** `group` / `peer` (optionally named, `group/row`) only mark an element for variants; they produce no CSS of their own. */
const MARKER_CLASS = /^(?:group|peer)(?:\/[\w-]+)?$/;

/** Whether Tailwind, with our theme, generates CSS for the class (variants included). */
export function generatesCss(candidate: string): boolean {
  if (MARKER_CLASS.test(candidate)) {
    return true;
  }
  let result = known.get(candidate);
  if (result === undefined) {
    result = designSystem.candidatesToCss([candidate])[0] != null;
    known.set(candidate, result);
  }
  return result;
}
