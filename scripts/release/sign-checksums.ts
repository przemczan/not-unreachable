/**
 * Signs a release's SHA256SUMS in the Release workflow's `sign` job (docs/design/deployment.md,
 * "Release signing"): writes SHA256SUMS.sig beside it, one `ed25519 <key id> <base64 signature>`
 * line per key, then checks the result as a host would, with the keys pinned in
 * deploy/keys/release-signing/.
 *
 * The private keys (PKCS#8 PEM) come from the environment and are never written to disk:
 * RELEASE_SIGNING_KEY, the active key, and during the 12 months after a rotation also
 * RELEASE_SIGNING_KEY_PREVIOUS, the one it replaced. Each must be pinned: a release signed with a
 * key no host trusts would be refused everywhere.
 *
 * Usage: node scripts/release/sign-checksums.ts <folder holding SHA256SUMS>
 */
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKSUMS_FILE,
  parseChecksums,
  readTrustedKeys,
  SIGNATURE_FILE,
  signingKeyId,
  verifyChecksumsSignature,
  type TrustedKeys,
} from "../../deploy/mount-helper/src/release-verify.mts";

export const PINNED_KEYS_FOLDER = fileURLToPath(new URL("../../deploy/keys/release-signing/", import.meta.url));
export const KEY_VARIABLES = ["RELEASE_SIGNING_KEY", "RELEASE_SIGNING_KEY_PREVIOUS"] as const;

/** The private keys the environment holds: the active key (required), then the previous one, if set. */
export function signingKeysFromEnvironment(environment: NodeJS.ProcessEnv): KeyObject[] {
  const [active, previous] = KEY_VARIABLES.map((name) => environment[name]?.trim() ?? "");
  if (active === undefined || active === "") throw new Error("RELEASE_SIGNING_KEY is not set");
  // An unset secret reaches a workflow step as an empty variable.
  return [active, ...(previous === undefined || previous === "" ? [] : [previous])].map((pem) => createPrivateKey(pem));
}

/**
 * The signature file's text for SHA256SUMS. Refuses a malformed SHA256SUMS, a key that isn't
 * Ed25519 or isn't pinned, and the same key twice; then verifies the result with the pinned keys.
 */
export function signChecksums(checksums: Uint8Array, privateKeys: readonly KeyObject[], trustedKeys: TrustedKeys): string {
  parseChecksums(checksums);
  if (privateKeys.length === 0) throw new Error("no signing key");
  const lines = privateKeys.map((privateKey) => {
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("a signing key is not an Ed25519 key");
    const keyId = signingKeyId(createPublicKey(privateKey));
    if (!trustedKeys.has(keyId)) throw new Error(`the signing key ${keyId} is not pinned in deploy/keys/release-signing/`);
    return `ed25519 ${keyId} ${sign(null, checksums, privateKey).toString("base64")}\n`;
  });
  if (new Set(lines.map((line) => line.split(" ")[1])).size !== lines.length) throw new Error("the same key is given twice");
  const signatureFile = lines.join("");
  // Every line is a pinned key's, so this checks each of them.
  verifyChecksumsSignature(checksums, Buffer.from(signatureFile), trustedKeys);
  return signatureFile;
}

async function main(folder: string): Promise<void> {
  const checksums = readFileSync(path.join(folder, CHECKSUMS_FILE));
  const signatureFile = signChecksums(checksums, signingKeysFromEnvironment(process.env), await readTrustedKeys(PINNED_KEYS_FOLDER));
  writeFileSync(path.join(folder, SIGNATURE_FILE), signatureFile, { mode: 0o644, flag: "wx" });
  const keyIds = signatureFile
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" ")[1]);
  console.log(`Signed ${CHECKSUMS_FILE} with ${keyIds.join(" and ")}; the signature verifies with the pinned keys.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [folder] = process.argv.slice(2);
  if (folder === undefined) {
    console.error("Usage: node scripts/release/sign-checksums.ts <folder holding SHA256SUMS>");
    process.exit(2);
  }
  await main(folder);
}
