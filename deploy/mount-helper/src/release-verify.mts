/**
 * Checking a release before it is installed (deployment.md, "Release signing"): the Ed25519
 * signature over SHA256SUMS with the pinned keys, the tarball's line of SHA256SUMS, and SemVer
 * precedence. Shared by the update helper, which trusts nothing else, and the server, which uses it
 * only to fail early with a clear reason.
 *
 * It imports only `node:` built-ins: the helpers run as root and ship as built files alone.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** What a release's own files can be refused for; each is one of the update reasons. */
export type ReleaseVerifyProblem = "unsigned" | "signature-invalid" | "checksum-mismatch";

export class ReleaseVerifyError extends Error {
  override readonly name = "ReleaseVerifyError";
  readonly problem: ReleaseVerifyProblem;

  constructor(problem: ReleaseVerifyProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

export const MAX_SIGNATURE_FILE_BYTES = 4096;
export const MAX_CHECKSUMS_FILE_BYTES = 16 * 1024;
export const MAX_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_SIGNATURE_LINES = 4;
export const MIN_TRUSTED_KEYS = 1;
export const MAX_TRUSTED_KEYS = 4;

export const CHECKSUMS_FILE = "SHA256SUMS";
export const SIGNATURE_FILE = "SHA256SUMS.sig";
/** The folder of a release bundle (and of an installed release) that holds the keys it trusts. */
export const TRUSTED_KEYS_FOLDER = "release-signing-keys";

export const releaseArchitectures = ["x64", "arm64"] as const;
export type ReleaseArchitecture = (typeof releaseArchitectures)[number];

/** A version as the releases name them: SemVer 2.0, as `build-tarball.sh` accepts it. */
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_VERSION_LENGTH = 64;

export function isReleaseVersion(value: string): boolean {
  return value.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(value);
}

export function isReleaseArchitecture(value: string): value is ReleaseArchitecture {
  return (releaseArchitectures as readonly string[]).includes(value);
}

/** The release architecture of a Node `process.arch`, or undefined when there is no release for it. */
export function releaseArchitecture(nodeArch: string): ReleaseArchitecture | undefined {
  return isReleaseArchitecture(nodeArch) ? nodeArch : undefined;
}

/** `not-unreachable-<version>-linux-<arch>`: the tarball's name without `.tar.gz`, and its one top folder. */
export function releaseName(version: string, arch: ReleaseArchitecture): string {
  return `not-unreachable-${version}-linux-${arch}`;
}

export function tarballName(version: string, arch: ReleaseArchitecture): string {
  return `${releaseName(version, arch)}.tar.gz`;
}

function prereleaseIdentifiers(version: string): string[] {
  const withoutBuild = version.split("+", 1)[0] ?? version;
  const dash = withoutBuild.indexOf("-");
  return dash === -1 ? [] : withoutBuild.slice(dash + 1).split(".");
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(BigInt(left) - BigInt(right)));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function coreIdentifiers(version: string): string[] {
  return (version.split(/[-+]/, 1)[0] ?? "").split(".");
}

/**
 * SemVer 2.0 precedence: negative when `left` comes before `right`, 0 when they rank the same
 * (build metadata is ignored), positive after. Both must be release versions.
 */
export function compareVersions(left: string, right: string): number {
  if (!isReleaseVersion(left) || !isReleaseVersion(right)) throw new TypeError("not a release version");
  const leftCore = coreIdentifiers(left);
  const rightCore = coreIdentifiers(right);
  for (let index = 0; index < 3; index += 1) {
    const order = compareIdentifiers(leftCore[index] ?? "0", rightCore[index] ?? "0");
    if (order !== 0) return order;
  }
  const leftPre = prereleaseIdentifiers(left);
  const rightPre = prereleaseIdentifiers(right);
  // A pre-release ranks before its release.
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;
  for (let index = 0; index < Math.min(leftPre.length, rightPre.length); index += 1) {
    const order = compareIdentifiers(leftPre[index] ?? "", rightPre[index] ?? "");
    if (order !== 0) return order;
  }
  return Math.sign(leftPre.length - rightPre.length);
}

/** The key id: the first 16 hex digits of the SHA-256 of the key's raw 32 bytes. */
export function signingKeyId(publicKey: KeyObject): string {
  const raw = publicKey.export({ format: "jwk" }).x;
  if (publicKey.asymmetricKeyType !== "ed25519" || raw === undefined) throw new TypeError("not an Ed25519 public key");
  return createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex").slice(0, 16);
}

/** The pinned keys by key id. */
export type TrustedKeys = ReadonlyMap<string, KeyObject>;

const KEY_FILE_PATTERN = /^([0-9a-f]{16})\.pem$/;

/**
 * Reads the keys a release pins, `<key id>.pem` each (SPKI PEM). Refuses the whole folder when a
 * file is named otherwise, isn't an Ed25519 public key, isn't named by its own id, or when it holds
 * fewer than 1 or more than 4 keys: a folder that isn't exactly as the release shipped it is no
 * trust anchor.
 */
export async function readTrustedKeys(folder: string): Promise<TrustedKeys> {
  const names = (await readdir(folder)).toSorted();
  if (names.length < MIN_TRUSTED_KEYS || names.length > MAX_TRUSTED_KEYS) {
    throw new Error(`${folder} holds ${names.length} keys; a release pins 1 to 4`);
  }
  const keys = new Map<string, KeyObject>();
  for (const name of names) {
    const id = KEY_FILE_PATTERN.exec(name)?.[1];
    if (id === undefined) throw new Error(`${name} is not named <key id>.pem`);
    const key = createPublicKey(await readFile(join(folder, name)));
    if (key.asymmetricKeyType !== "ed25519") throw new Error(`${name} is not an Ed25519 public key`);
    if (signingKeyId(key) !== id) throw new Error(`${name} is not named by its key id`);
    keys.set(id, key);
  }
  return keys;
}

export interface SignatureLine {
  readonly keyId: string;
  readonly signature: Buffer;
}

const SIGNATURE_LINE_PATTERN = /^ed25519 ([0-9a-f]{16}) ([A-Za-z0-9+/]{86}==)$/;

/**
 * Parses `SHA256SUMS.sig`: UTF-8, at most 4 KiB, 1 to 4 lines `ed25519 <key id> <base64 signature>`,
 * each ending in a newline. Any other shape refuses the whole file (`signature-invalid`).
 */
export function parseSignatureFile(content: Uint8Array): SignatureLine[] {
  if (content.byteLength > MAX_SIGNATURE_FILE_BYTES) throw new ReleaseVerifyError("signature-invalid", "the signature file is too large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new ReleaseVerifyError("signature-invalid", "the signature file is not UTF-8");
  }
  if (!text.endsWith("\n")) throw new ReleaseVerifyError("signature-invalid", "the signature file doesn't end in a newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > MAX_SIGNATURE_LINES) {
    throw new ReleaseVerifyError("signature-invalid", "the signature file must have 1 to 4 lines");
  }
  const seen = new Set<string>();
  return lines.map((line) => {
    const match = SIGNATURE_LINE_PATTERN.exec(line);
    const keyId = match?.[1];
    const signature = match?.[2];
    if (keyId === undefined || signature === undefined) throw new ReleaseVerifyError("signature-invalid", "a signature line is malformed");
    if (seen.has(keyId)) throw new ReleaseVerifyError("signature-invalid", "a key signs twice");
    seen.add(keyId);
    const bytes = Buffer.from(signature, "base64");
    if (bytes.byteLength !== 64) throw new ReleaseVerifyError("signature-invalid", "a signature is not 64 bytes");
    return { keyId, signature: bytes };
  });
}

/**
 * Verifies `SHA256SUMS` against its signature file with the trusted keys. Lines of keys it doesn't
 * trust are skipped; it accepts only when at least one trusted line verifies and none fails.
 * Answers the key id that verified it (the first trusted line's).
 */
export function verifyChecksumsSignature(checksums: Uint8Array, signatureFile: Uint8Array, trustedKeys: TrustedKeys): string {
  const trustedLines = parseSignatureFile(signatureFile).filter((line) => trustedKeys.has(line.keyId));
  const [first] = trustedLines;
  if (first === undefined) throw new ReleaseVerifyError("unsigned", "no signature by a trusted key");
  for (const line of trustedLines) {
    const key = trustedKeys.get(line.keyId);
    if (key === undefined || !verify(null, checksums, key, line.signature)) {
      throw new ReleaseVerifyError("signature-invalid", `the signature by ${line.keyId} doesn't verify`);
    }
  }
  return first.keyId;
}

const CHECKSUM_LINE_PATTERN = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._+-]*)$/;

/**
 * Parses `SHA256SUMS`: `<64 lower-case hex>  <file name>` per line, each ending in a newline, each
 * name once. Anything else is `checksum-mismatch`, as the file can't vouch for the tarball.
 */
export function parseChecksums(content: Uint8Array): ReadonlyMap<string, string> {
  if (content.byteLength > MAX_CHECKSUMS_FILE_BYTES) throw new ReleaseVerifyError("checksum-mismatch", "SHA256SUMS is too large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new ReleaseVerifyError("checksum-mismatch", "SHA256SUMS is not UTF-8");
  }
  if (!text.endsWith("\n")) throw new ReleaseVerifyError("checksum-mismatch", "SHA256SUMS doesn't end in a newline");
  const checksums = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = CHECKSUM_LINE_PATTERN.exec(line);
    const digest = match?.[1];
    const name = match?.[2];
    if (digest === undefined || name === undefined) throw new ReleaseVerifyError("checksum-mismatch", "SHA256SUMS has a malformed line");
    if (checksums.has(name)) throw new ReleaseVerifyError("checksum-mismatch", "SHA256SUMS lists a file twice");
    checksums.set(name, digest);
  }
  return checksums;
}

/** The SHA-256 SHA256SUMS gives for the file; `checksum-mismatch` when it lists none. */
export function expectedChecksum(checksums: ReadonlyMap<string, string>, fileName: string): string {
  const digest = checksums.get(fileName);
  if (digest === undefined) throw new ReleaseVerifyError("checksum-mismatch", `SHA256SUMS has no line for ${fileName}`);
  return digest;
}

/** Throws `checksum-mismatch` unless the digest (lower-case hex) is the one SHA256SUMS gives the file. */
export function checkChecksum(checksums: ReadonlyMap<string, string>, fileName: string, actualDigest: string): void {
  if (expectedChecksum(checksums, fileName) !== actualDigest) {
    throw new ReleaseVerifyError("checksum-mismatch", `${fileName} doesn't match SHA256SUMS`);
  }
}
