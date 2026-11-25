import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Removes the run's data directory and master key (created by playwright.config.ts). */
export default async function globalTeardown(): Promise<void> {
  const directory = process.env["NU_E2E_DIR"];
  if (directory === undefined || directory !== join(tmpdir(), "not-unreachable-e2e")) return;
  await rm(directory, { recursive: true, force: true });
}
