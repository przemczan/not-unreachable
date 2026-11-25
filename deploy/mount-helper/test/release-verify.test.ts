import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the checks are one file, not a module with an index.ts.
import {
  checkChecksum,
  compareVersions,
  isReleaseVersion,
  parseChecksums,
  parseSignatureFile,
  readTrustedKeys,
  releaseArchitecture,
  releaseName,
  ReleaseVerifyError,
  signingKeyId,
  tarballName,
  verifyChecksumsSignature,
  type ReleaseVerifyProblem,
  type TrustedKeys,
} from "../src/release-verify.mts";

interface KeyPair {
  readonly id: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

function keyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { id: signingKeyId(publicKey), publicKey, privateKey };
}

const active = keyPair();
const backup = keyPair();
const stranger = keyPair();

const CHECKSUMS = Buffer.from(
  `${"a".repeat(64)}  not-unreachable-1.5.0-linux-x64.tar.gz\n${"b".repeat(64)}  not-unreachable-1.5.0-linux-arm64.tar.gz\n${"c".repeat(64)}  install.sh\n`,
);

function line(key: KeyPair, content: Uint8Array = CHECKSUMS): string {
  return `ed25519 ${key.id} ${sign(null, content, key.privateKey).toString("base64")}`;
}

function signatureFile(...lines: string[]): Buffer {
  return Buffer.from(`${lines.join("\n")}\n`);
}

function trusting(...keys: KeyPair[]): TrustedKeys {
  return new Map(keys.map((key) => [key.id, key.publicKey]));
}

function problemOf(work: () => unknown): ReleaseVerifyProblem | "none" {
  try {
    work();
    return "none";
  } catch (error) {
    if (error instanceof ReleaseVerifyError) return error.problem;
    throw error;
  }
}

describe("release versions", () => {
  it.each([
    "0.0.0",
    "1.5.0",
    "10.20.30",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-0.3.7",
    "1.0.0-x-y.z",
    "1.0.0+build.1",
    "1.0.0-rc.1+sha.5114f85",
  ])("takes %s", (version) => {
    expect(isReleaseVersion(version)).toBe(true);
  });

  it.each([
    "",
    "v1.5.0",
    "1.5",
    "1.5.0.0",
    "01.5.0",
    "1.05.0",
    "1.5.0-",
    "1.5.0-01",
    "1.5.0+",
    "1.5.0 ",
    "1.5.0\n",
    "../1.5.0",
    `1.0.0-${"a".repeat(60)}`,
  ])("refuses %j", (version) => {
    expect(isReleaseVersion(version)).toBe(false);
  });

  // The order SemVer 2.0's own example gives, then the numeric cases.
  const ordered = [
    "0.9.9",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.9.0",
    "1.10.0",
    "2.0.0",
    "12345678901234567890.0.0",
  ];

  it("orders versions by SemVer 2.0 precedence", () => {
    for (const [index, left] of ordered.entries()) {
      for (const [other, right] of ordered.entries()) {
        expect(Math.sign(compareVersions(left, right)), `${left} vs ${right}`).toBe(Math.sign(index - other));
      }
    }
  });

  it("ignores build metadata", () => {
    expect(compareVersions("1.5.0+a", "1.5.0+b")).toBe(0);
    expect(compareVersions("1.5.0+a", "1.5.0")).toBe(0);
    expect(compareVersions("1.5.0-rc.1+x", "1.5.0-rc.1")).toBe(0);
    expect(compareVersions("1.5.0-rc.1+x", "1.5.0")).toBeLessThan(0);
  });

  it("compares numeric identifiers as numbers and before alphanumeric ones", () => {
    expect(compareVersions("1.0.0-2", "1.0.0-10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-10", "1.0.0-a")).toBeLessThan(0);
    expect(compareVersions("1.0.0-a-b", "1.0.0-a")).toBeGreaterThan(0);
  });

  it("refuses to compare what isn't a release version", () => {
    expect(() => compareVersions("1.5", "1.5.0")).toThrow(TypeError);
  });

  it("names the release, its tarball and its architecture", () => {
    expect(releaseArchitecture("x64")).toBe("x64");
    expect(releaseArchitecture("arm64")).toBe("arm64");
    expect(releaseArchitecture("ia32")).toBeUndefined();
    expect(releaseName("1.5.0", "arm64")).toBe("not-unreachable-1.5.0-linux-arm64");
    expect(tarballName("1.5.0", "x64")).toBe("not-unreachable-1.5.0-linux-x64.tar.gz");
  });
});

describe("the key id", () => {
  it("is the first 16 hex digits of the SHA-256 of the raw key", () => {
    const raw = active.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    expect(active.id).toBe(createHash("sha256").update(raw).digest("hex").slice(0, 16));
  });
});

describe("the pinned keys", () => {
  let folder: string;

  beforeEach(async () => {
    folder = join(await mkdtemp(join(tmpdir(), "release-keys-")), "release-signing-keys");
    await mkdir(folder);
  });

  afterEach(async () => {
    await rm(join(folder, ".."), { recursive: true, force: true });
  });

  async function pin(key: KeyObject, name: string): Promise<void> {
    await writeFile(join(folder, name), key.export({ format: "pem", type: "spki" }));
  }

  it("reads 1 to 4 keys, each named by its id", async () => {
    await pin(active.publicKey, `${active.id}.pem`);
    await pin(backup.publicKey, `${backup.id}.pem`);
    const keys = await readTrustedKeys(folder);
    expect([...keys.keys()].toSorted()).toEqual([active.id, backup.id].toSorted());
  });

  it("refuses an empty folder", async () => {
    await expect(readTrustedKeys(folder)).rejects.toThrow(/1 to 4/u);
  });

  it("refuses five keys", async () => {
    for (let index = 0; index < 5; index += 1) {
      const key = keyPair();
      await pin(key.publicKey, `${key.id}.pem`);
    }
    await expect(readTrustedKeys(folder)).rejects.toThrow(/1 to 4/u);
  });

  it("refuses a key named by another key's id", async () => {
    await pin(active.publicKey, `${backup.id}.pem`);
    await expect(readTrustedKeys(folder)).rejects.toThrow(/its key id/u);
  });

  it.each(["key.pem", "ABCDEF0123456789.pem", `${"a".repeat(16)}.pub`, "README"])("refuses a file named %s", async (name) => {
    await pin(active.publicKey, `${active.id}.pem`);
    await writeFile(join(folder, name), "x");
    await expect(readTrustedKeys(folder)).rejects.toThrow(/<key id>\.pem/u);
  });

  it("refuses a key that isn't Ed25519", async () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    await pin(publicKey, `${"0".repeat(16)}.pem`);
    await expect(readTrustedKeys(folder)).rejects.toThrow(/Ed25519/u);
  });
});

describe("the signature of SHA256SUMS", () => {
  it("verifies with a trusted key and names it", () => {
    expect(verifyChecksumsSignature(CHECKSUMS, signatureFile(line(active)), trusting(active, backup))).toBe(active.id);
  });

  it("skips lines of keys it doesn't trust", () => {
    expect(verifyChecksumsSignature(CHECKSUMS, signatureFile(line(stranger), line(backup)), trusting(active, backup))).toBe(backup.id);
  });

  it("names the first trusted line when two verify", () => {
    expect(verifyChecksumsSignature(CHECKSUMS, signatureFile(line(backup), line(active)), trusting(active, backup))).toBe(backup.id);
  });

  it("is unsigned with no line of a trusted key", () => {
    expect(problemOf(() => verifyChecksumsSignature(CHECKSUMS, signatureFile(line(stranger)), trusting(active)))).toBe("unsigned");
  });

  it("refuses when a trusted line fails, even beside one that verifies", () => {
    const forged = line(backup, Buffer.from("something else\n"));
    expect(problemOf(() => verifyChecksumsSignature(CHECKSUMS, signatureFile(line(active), forged), trusting(active, backup)))).toBe(
      "signature-invalid",
    );
  });

  it("refuses a signature by an untrusted key posing under a trusted id", () => {
    const posing = `ed25519 ${active.id} ${sign(null, CHECKSUMS, stranger.privateKey).toString("base64")}`;
    expect(problemOf(() => verifyChecksumsSignature(CHECKSUMS, signatureFile(posing), trusting(active)))).toBe("signature-invalid");
  });

  it("refuses checksums changed after signing", () => {
    const tampered = Buffer.from(CHECKSUMS.toString().replace("aaaa", "aaab"));
    expect(problemOf(() => verifyChecksumsSignature(tampered, signatureFile(line(active)), trusting(active)))).toBe("signature-invalid");
  });

  const signature = sign(null, CHECKSUMS, active.privateKey).toString("base64");
  it.each<[string, () => Buffer]>([
    ["an empty file", () => Buffer.alloc(0)],
    ["a missing final newline", () => Buffer.from(line(active))],
    ["an empty line", () => signatureFile(line(active), "")],
    ["CRLF line ends", () => Buffer.from(`${line(active)}\r\n`)],
    ["five lines", () => signatureFile(...[active, backup, stranger, keyPair(), keyPair()].map((key) => line(key)))],
    ["another algorithm", () => signatureFile(`rsa ${active.id} ${signature}`)],
    ["an upper-case key id", () => signatureFile(`ed25519 ${active.id.toUpperCase()} ${signature}`)],
    ["a short key id", () => signatureFile(`ed25519 ${active.id.slice(1)} ${signature}`)],
    ["unpadded base64", () => signatureFile(`ed25519 ${active.id} ${signature.replace(/=+$/u, "")}`)],
    // Its own characters in place of the first two: a random signature may have no `+` or `/` to swap.
    ["base64url", () => signatureFile(`ed25519 ${active.id} -_${signature.slice(2)}`)],
    ["a short signature", () => signatureFile(`ed25519 ${active.id} ${Buffer.alloc(63).toString("base64")}`)],
    ["two spaces", () => signatureFile(`ed25519  ${active.id} ${signature}`)],
    ["a trailing space", () => signatureFile(`${line(active)} `)],
    ["a key that signs twice", () => signatureFile(line(active), line(active))],
    ["bytes that aren't UTF-8", () => Buffer.concat([Buffer.from([0xff, 0xfe]), signatureFile(line(active))])],
    ["more than 4 KiB", () => Buffer.alloc(4097, 0x61)],
  ])("refuses the whole file for %s", (_case, file) => {
    expect(problemOf(() => verifyChecksumsSignature(CHECKSUMS, file(), trusting(active)))).toBe("signature-invalid");
  });

  it("parses up to four lines", () => {
    const lines = [active, backup, stranger, keyPair()].map((key) => line(key));
    expect(parseSignatureFile(signatureFile(...lines))).toHaveLength(4);
  });
});

describe("SHA256SUMS", () => {
  it("gives each file's digest", () => {
    const checksums = parseChecksums(CHECKSUMS);
    expect(checksums.get("install.sh")).toBe("c".repeat(64));
    expect(checksums.size).toBe(3);
  });

  it("accepts the tarball's digest and refuses another", () => {
    const checksums = parseChecksums(CHECKSUMS);
    expect(problemOf(() => checkChecksum(checksums, "not-unreachable-1.5.0-linux-x64.tar.gz", "a".repeat(64)))).toBe("none");
    expect(problemOf(() => checkChecksum(checksums, "not-unreachable-1.5.0-linux-x64.tar.gz", "b".repeat(64)))).toBe("checksum-mismatch");
  });

  it("refuses a file it has no line for", () => {
    expect(problemOf(() => checkChecksum(parseChecksums(CHECKSUMS), "not-unreachable-1.6.0-linux-x64.tar.gz", "a".repeat(64)))).toBe(
      "checksum-mismatch",
    );
  });

  it.each<[string, string]>([
    ["an empty file", ""],
    ["a missing final newline", `${"a".repeat(64)}  install.sh`],
    ["upper-case hex", `${"A".repeat(64)}  install.sh\n`],
    ["a short digest", `${"a".repeat(63)}  install.sh\n`],
    ["one space", `${"a".repeat(64)} install.sh\n`],
    ["binary mode", `${"a".repeat(64)} *install.sh\n`],
    ["a path", `${"a".repeat(64)}  dir/install.sh\n`],
    ["a name starting with a dot", `${"a".repeat(64)}  ../install.sh\n`],
    ["CRLF line ends", `${"a".repeat(64)}  install.sh\r\n`],
    ["an empty line", `${"a".repeat(64)}  install.sh\n\n`],
    ["a file listed twice", `${"a".repeat(64)}  install.sh\n${"b".repeat(64)}  install.sh\n`],
  ])("refuses %s", (_case, content) => {
    expect(problemOf(() => parseChecksums(Buffer.from(content)))).toBe("checksum-mismatch");
  });

  it("refuses more than 16 KiB", () => {
    expect(problemOf(() => parseChecksums(Buffer.alloc(16 * 1024 + 1, 0x61)))).toBe("checksum-mismatch");
  });
});
