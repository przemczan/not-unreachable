/**
 * Runs semantic-release with .releaserc.json and hands its result to the Release workflow
 * (.github/workflows/release.yml) as step outputs, the one source of the release's version:
 *
 * - `version`: the version it released or, in a dry run, would release;
 * - `tag`: the tag it created and the draft GitHub Release it opened, such as `v1.2.3`.
 *
 * Both are empty when no commit since the last release calls for one; `tag` is also empty in a dry run.
 *
 * Usage: node scripts/release/semantic-release.ts [--dry-run]
 */
import { appendFileSync } from "node:fs";
import semanticRelease from "semantic-release";

const dryRun = process.argv.includes("--dry-run");
const result = await semanticRelease({ dryRun });
const nextRelease = result === false ? undefined : result.nextRelease;

const outputs = [`version=${nextRelease?.version ?? ""}`, `tag=${dryRun ? "" : (nextRelease?.gitTag ?? "")}`];
const outputFile = process.env["GITHUB_OUTPUT"];
if (outputFile === undefined) {
  console.log(outputs.join("\n"));
} else {
  appendFileSync(outputFile, `${outputs.join("\n")}\n`);
}
