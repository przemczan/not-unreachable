/**
 * Makes a release signing key pair (docs/design/deployment.md, "Release signing"): an Ed25519 key
 * whose public half is pinned as deploy/keys/release-signing/<key id>.pem (SPKI PEM), and whose
 * private half (PKCS#8 PEM) goes to the path the maintainer gives, mode 0600. Neither file is ever
 * overwritten. The private key belongs in the `release-signing` environment's RELEASE_SIGNING_KEY
 * (the active key) or offline (the backup key), never in the repository.
 *
 * Usage: node scripts/release/generate-signing-key.ts <private key file> [pinned keys folder]
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signingKeyId } from "../../deploy/mount-helper/src/release-verify.mts";

export const PINNED_KEYS_FOLDER = fileURLToPath(new URL("../../deploy/keys/release-signing/", import.meta.url));

export interface GeneratedKey {
  readonly keyId: string;
  readonly publicKeyFile: string;
}

export function generateSigningKey(privateKeyFile: string, pinnedKeysFolder = PINNED_KEYS_FOLDER): GeneratedKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = signingKeyId(publicKey);
  const publicKeyFile = path.join(pinnedKeysFolder, `${keyId}.pem`);
  // The private key first, with O_EXCL: if that path is taken, nothing is pinned for a key nobody has.
  mkdirSync(path.dirname(privateKeyFile), { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  mkdirSync(pinnedKeysFolder, { recursive: true });
  writeFileSync(publicKeyFile, publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644, flag: "wx" });
  return { keyId, publicKeyFile };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [privateKeyFile, pinnedKeysFolder] = process.argv.slice(2);
  if (privateKeyFile === undefined) {
    console.error("Usage: node scripts/release/generate-signing-key.ts <private key file> [pinned keys folder]");
    process.exit(2);
  }
  const { keyId, publicKeyFile } = generateSigningKey(path.resolve(privateKeyFile), pinnedKeysFolder);
  console.log(`Key id ${keyId}: public key pinned in ${publicKeyFile}, private key in ${privateKeyFile} (keep it secret).`);
}
