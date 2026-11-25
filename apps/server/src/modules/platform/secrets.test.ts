import { randomBytes } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/index.ts";
import { loadMasterKey, MasterKeyError, readMasterKeyFile, writeKeyFile } from "./master-key.ts";
import { createSecrets, SecretDecryptionError, type EnvelopeAad } from "./secrets.ts";

const aad: EnvelopeAad = { table: "resources", column: "smb_password", rowId: "0196a1b2-0000-7000-8000-000000000001" };

function corrupt(envelope: string, index: number): string {
  const bytes = Buffer.from(envelope, "base64url");
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return bytes.toString("base64url");
}

describe("createSecrets", () => {
  const key = randomBytes(32);
  const secrets = createSecrets(key);

  it("round-trips, with a fresh nonce each time", () => {
    const first = secrets.encrypt("smb", aad, "correct horse battery staple ✓");
    const second = secrets.encrypt("smb", aad, "correct horse battery staple ✓");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secrets.decrypt("smb", aad, first)).toBe("correct horse battery staple ✓");
    expect(secrets.decrypt("smb", aad, secrets.encrypt("smb", aad, ""))).toBe("");
  });

  it("lays the envelope out as version ‖ key id ‖ nonce ‖ ciphertext ‖ tag", () => {
    const bytes = Buffer.from(secrets.encrypt("totp", aad, "12345"), "base64url");
    expect(bytes[0]).toBe(1);
    expect(bytes.subarray(1, 5).toString("hex")).toBe(secrets.keyId);
    expect(bytes.length).toBe(1 + 4 + 12 + 5 + 16);
  });

  const envelope = secrets.encrypt("smb", aad, "s3cret-value");
  const length = Buffer.from(envelope, "base64url").length;
  it.each([
    ["version", 0],
    ["key id", 2],
    ["nonce", 5],
    ["nonce (last byte)", 16],
    ["ciphertext", 17],
    ["tag", length - 16],
    ["tag (last byte)", length - 1],
  ])("rejects a tampered %s byte", (_part, index) => {
    expect(() => secrets.decrypt("smb", aad, corrupt(envelope, index))).toThrow(SecretDecryptionError);
  });

  it("rejects a truncated envelope", () => {
    expect(() => secrets.decrypt("smb", aad, envelope.slice(0, 20))).toThrow(SecretDecryptionError);
  });

  it.each([
    ["row id", { ...aad, rowId: "0196a1b2-0000-7000-8000-000000000002" }],
    ["column", { ...aad, column: "smtp_password" }],
    ["table", { ...aad, table: "mail_settings" }],
  ])("rejects an envelope moved to another %s", (_what, otherAad) => {
    expect(() => secrets.decrypt("smb", otherAad, envelope)).toThrow(SecretDecryptionError);
  });

  it("rejects an envelope decrypted for another purpose", () => {
    expect(() => secrets.decrypt("totp", aad, envelope)).toThrow(SecretDecryptionError);
  });

  it("rejects an envelope from another master key by its key id", () => {
    const other = createSecrets(randomBytes(32));
    expect(other.keyId).not.toBe(secrets.keyId);
    expect(() => other.decrypt("smb", aad, envelope)).toThrow(/another master key/);
  });

  it("gives the same key id for the same key", () => {
    expect(createSecrets(Buffer.from(key)).keyId).toBe(secrets.keyId);
  });

  it("refuses a key that isn't 32 bytes", () => {
    expect(() => createSecrets(randomBytes(31))).toThrow(RangeError);
  });

  it("gives a stable keyed hash per purpose and master key", () => {
    const mac = secrets.mac("sign-in-identifier", "alice");
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createSecrets(Buffer.from(key)).mac("sign-in-identifier", "alice")).toBe(mac);
    expect(secrets.mac("sign-in-identifier", "alicf")).not.toBe(mac);
    expect(secrets.mac("test", "alice")).not.toBe(mac);
    expect(createSecrets(randomBytes(32)).mac("sign-in-identifier", "alice")).not.toBe(mac);
  });
});

function messageOf(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    if (error instanceof MasterKeyError) return error.message;
    throw error;
  }
  throw new Error("expected the key to be refused");
}

function expectNoKeyBytes(message: string, key: Buffer): void {
  for (const encoding of ["hex", "base64", "base64url", "latin1"] as const) {
    expect(message).not.toContain(key.toString(encoding));
    expect(message).not.toContain(key.subarray(0, 8).toString(encoding));
  }
}

describe("loadMasterKey", () => {
  let temp: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    temp = makeTempDir();
  });
  afterEach(() => temp.cleanup());

  it("reads exactly 32 bytes from $CREDENTIALS_DIRECTORY/master.key", () => {
    const key = randomBytes(32);
    writeFileSync(join(temp.dir, "master.key"), key);
    expect(loadMasterKey({ CREDENTIALS_DIRECTORY: temp.dir }).equals(key)).toBe(true);
  });

  it("refuses when CREDENTIALS_DIRECTORY is not set", () => {
    expect(messageOf(() => loadMasterKey({}))).toContain("CREDENTIALS_DIRECTORY");
    expect(messageOf(() => loadMasterKey({ CREDENTIALS_DIRECTORY: " " }))).toContain("CREDENTIALS_DIRECTORY");
  });

  it("refuses when the file is missing", () => {
    expect(messageOf(() => loadMasterKey({ CREDENTIALS_DIRECTORY: temp.dir }))).toMatch(/master\.key does not exist/);
  });

  it("refuses when the file can't be read", () => {
    expect(messageOf(() => readMasterKeyFile(temp.dir))).toMatch(/cannot be read/);
  });

  it.each([31, 33, 0])("refuses a %i-byte key without echoing it", (size) => {
    const key = randomBytes(size);
    writeFileSync(join(temp.dir, "master.key"), key);
    const message = messageOf(() => loadMasterKey({ CREDENTIALS_DIRECTORY: temp.dir }));
    expect(message).toContain(`exactly 32 bytes, it holds ${size}`);
    if (size > 0) expectNoKeyBytes(message, key);
  });

  it("writes key files with mode 0600", () => {
    const file = join(temp.dir, "master.key");
    const key = randomBytes(32);
    writeKeyFile(file, key);
    writeKeyFile(file, key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readMasterKeyFile(file).equals(key)).toBe(true);
  });
});
