import { spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TRUSTED_KEYS,
  MIN_TRUSTED_KEYS,
  readTrustedKeys,
  signingKeyId,
  verifyChecksumsSignature,
} from "../../deploy/mount-helper/src/release-verify.mts";
import { generateSigningKey, PINNED_KEYS_FOLDER } from "./generate-signing-key.ts";
import { signChecksums, signingKeysFromEnvironment } from "./sign-checksums.ts";

const CHECKSUMS = Buffer.from(
  `${"a".repeat(64)}  not-unreachable-1.2.3-linux-x64.tar.gz\n${"b".repeat(64)}  not-unreachable-1.2.3-linux-arm64.tar.gz\n${"c".repeat(64)}  install.sh\n`,
);

const folders: string[] = [];

function temporaryFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "sign-checksums-"));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function keyPair(): { privateKey: KeyObject; publicKey: KeyObject; id: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, id: signingKeyId(publicKey) };
}

function trusted(...keys: { publicKey: KeyObject; id: string }[]): Map<string, KeyObject> {
  return new Map(keys.map((key) => [key.id, key.publicKey]));
}

const ids = (keys: KeyObject[]) => keys.map((key) => signingKeyId(createPublicKey(key)));

const pem = (key: KeyObject) => key.export({ format: "pem", type: "pkcs8" }).toString();

describe("signChecksums", () => {
  it("signs with the active key, in the design's format, and the result verifies", () => {
    const active = keyPair();
    const backup = keyPair();
    const signature = signChecksums(CHECKSUMS, [active.privateKey], trusted(active, backup));
    expect(signature).toMatch(new RegExp(`^ed25519 ${active.id} [A-Za-z0-9+/]{86}==\\n$`));
    expect(verifyChecksumsSignature(CHECKSUMS, Buffer.from(signature), trusted(active, backup))).toBe(active.id);
    // A host that pins only the backup finds no line it trusts.
    expect(() => verifyChecksumsSignature(CHECKSUMS, Buffer.from(signature), trusted(backup))).toThrow(/no signature by a trusted key/);
  });

  it("signs with both keys after a rotation, one line each, so hosts pinning either accept it", () => {
    const current = keyPair();
    const previous = keyPair();
    const signature = signChecksums(CHECKSUMS, [current.privateKey, previous.privateKey], trusted(current, previous));
    const lines = signature.trimEnd().split("\n");
    expect(lines.map((line) => line.split(" ")[1])).toEqual([current.id, previous.id]);
    expect(verifyChecksumsSignature(CHECKSUMS, Buffer.from(signature), trusted(previous))).toBe(previous.id);
    expect(verifyChecksumsSignature(CHECKSUMS, Buffer.from(signature), trusted(current))).toBe(current.id);
  });

  it("refuses a key that isn't pinned, even beside one that is", () => {
    const pinned = keyPair();
    const stranger = keyPair();
    expect(() => signChecksums(CHECKSUMS, [stranger.privateKey], trusted(pinned))).toThrow(`${stranger.id} is not pinned`);
    expect(() => signChecksums(CHECKSUMS, [pinned.privateKey, stranger.privateKey], trusted(pinned))).toThrow("is not pinned");
  });

  it("refuses the same key twice, a key that isn't Ed25519 and no key", () => {
    const key = keyPair();
    expect(() => signChecksums(CHECKSUMS, [key.privateKey, key.privateKey], trusted(key))).toThrow("twice");
    const { privateKey: ecKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => signChecksums(CHECKSUMS, [ecKey], trusted(key))).toThrow("not an Ed25519 key");
    expect(() => signChecksums(CHECKSUMS, [], trusted(key))).toThrow("no signing key");
  });

  it("refuses a malformed SHA256SUMS", () => {
    const key = keyPair();
    expect(() => signChecksums(Buffer.from("not a checksum line\n"), [key.privateKey], trusted(key))).toThrow(/malformed/);
  });

  it("signs the exact bytes: one changed byte no longer verifies", () => {
    const key = keyPair();
    const signature = signChecksums(CHECKSUMS, [key.privateKey], trusted(key));
    const tampered = Buffer.from(CHECKSUMS);
    tampered[0] = "d".charCodeAt(0);
    expect(() => verifyChecksumsSignature(tampered, Buffer.from(signature), trusted(key))).toThrow(/doesn't verify/);
  });
});

describe("signingKeysFromEnvironment", () => {
  it("takes the active key, and the previous one only when it is set", () => {
    const active = keyPair();
    const previous = keyPair();
    expect(ids(signingKeysFromEnvironment({ RELEASE_SIGNING_KEY: pem(active.privateKey) }))).toEqual([active.id]);
    expect(ids(signingKeysFromEnvironment({ RELEASE_SIGNING_KEY: pem(active.privateKey), RELEASE_SIGNING_KEY_PREVIOUS: "" }))).toEqual([
      active.id,
    ]);
    expect(
      ids(
        signingKeysFromEnvironment({ RELEASE_SIGNING_KEY: pem(active.privateKey), RELEASE_SIGNING_KEY_PREVIOUS: pem(previous.privateKey) }),
      ),
    ).toEqual([active.id, previous.id]);
  });

  it("fails without the active key", () => {
    expect(() => signingKeysFromEnvironment({})).toThrow("RELEASE_SIGNING_KEY is not set");
    expect(() => signingKeysFromEnvironment({ RELEASE_SIGNING_KEY: "" })).toThrow("RELEASE_SIGNING_KEY is not set");
  });
});

describe("sign-checksums.ts, run as the sign job runs it", () => {
  const script = path.join(import.meta.dirname, "sign-checksums.ts");
  const runScript = (folder: string, environment: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [script, folder], { encoding: "utf8", env: { PATH: process.env["PATH"], ...environment } });

  it("refuses a key from the environment that the repository doesn't pin, and writes nothing", () => {
    const folder = temporaryFolder();
    writeFileSync(path.join(folder, "SHA256SUMS"), CHECKSUMS);
    const signed = runScript(folder, { RELEASE_SIGNING_KEY: pem(keyPair().privateKey) });
    expect(signed.status).not.toBe(0);
    expect(signed.stderr).toContain("is not pinned");
    expect(readdirSync(folder)).toEqual(["SHA256SUMS"]);
  });
});

describe("the pinned keys (deploy/keys/release-signing/)", () => {
  it(`hold ${MIN_TRUSTED_KEYS} to ${MAX_TRUSTED_KEYS} Ed25519 keys, each file named by its key's id`, async () => {
    const names = readdirSync(PINNED_KEYS_FOLDER).toSorted();
    expect(names.length).toBeGreaterThanOrEqual(MIN_TRUSTED_KEYS);
    expect(names.length).toBeLessThanOrEqual(MAX_TRUSTED_KEYS);
    for (const name of names) {
      const key = createPublicKey(readFileSync(path.join(PINNED_KEYS_FOLDER, name)));
      expect(key.asymmetricKeyType, name).toBe("ed25519");
      expect(name).toBe(`${signingKeyId(key)}.pem`);
    }
    // The same rules the update helper applies to an installed release's folder.
    expect([...(await readTrustedKeys(PINNED_KEYS_FOLDER)).keys()].toSorted()).toEqual(names.map((name) => name.replace(".pem", "")));
  });

  it("are public keys only", () => {
    for (const name of readdirSync(PINNED_KEYS_FOLDER)) {
      expect(readFileSync(path.join(PINNED_KEYS_FOLDER, name), "utf8"), name).toMatch(
        /^-----BEGIN PUBLIC KEY-----\n[^-]+-----END PUBLIC KEY-----\n$/,
      );
    }
  });

  it("are the ones docs/install.md lists for checking a release by hand", () => {
    const guide = readFileSync(path.join(import.meta.dirname, "../../docs/install.md"), "utf8");
    const listed = [...guide.matchAll(/^\| (?:Active|Backup) +\| `([0-9a-f]{16})` +\| `([A-Za-z0-9+/=]+)` +\|$/gmu)].map(
      (match) => `${match[1]}.pem`,
    );
    expect(listed.toSorted()).toEqual(readdirSync(PINNED_KEYS_FOLDER).toSorted());
    for (const match of guide.matchAll(/^\| (?:Active|Backup) +\| `([0-9a-f]{16})` +\| `([A-Za-z0-9+/=]+)` +\|$/gmu)) {
      expect(readFileSync(path.join(PINNED_KEYS_FOLDER, `${match[1]}.pem`), "utf8")).toContain(`\n${match[2]}\n`);
    }
  });
});

describe("generateSigningKey", () => {
  it("pins the public key by its id and writes the private key 0600, refusing to overwrite either", () => {
    const folder = temporaryFolder();
    const pinned = path.join(folder, "pinned");
    const privateKeyFile = path.join(folder, "private", "active.pem");
    const { keyId, publicKeyFile } = generateSigningKey(privateKeyFile, pinned);
    expect(publicKeyFile).toBe(path.join(pinned, `${keyId}.pem`));
    expect(statSync(privateKeyFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(privateKeyFile)).mode & 0o777).toBe(0o700);
    const signature = signChecksums(
      CHECKSUMS,
      signingKeysFromEnvironment({ RELEASE_SIGNING_KEY: readFileSync(privateKeyFile, "utf8") }),
      new Map([[keyId, createPublicKey(readFileSync(publicKeyFile))]]),
    );
    expect(signature).toContain(` ${keyId} `);

    const before = readFileSync(privateKeyFile);
    expect(() => generateSigningKey(privateKeyFile, pinned)).toThrow(/EEXIST/);
    expect(readFileSync(privateKeyFile)).toEqual(before);
    expect(readdirSync(pinned)).toEqual([`${keyId}.pem`]);
  });

  it("refuses a taken private key path before pinning anything", () => {
    const folder = temporaryFolder();
    mkdirSync(path.join(folder, "pinned"));
    writeFileSync(path.join(folder, "taken.pem"), "");
    expect(() => generateSigningKey(path.join(folder, "taken.pem"), path.join(folder, "pinned"))).toThrow(/EEXIST/);
    expect(readdirSync(path.join(folder, "pinned"))).toEqual([]);
  });
});
