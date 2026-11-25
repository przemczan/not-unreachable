import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/** What a derived key is for; each gets its own HKDF key (`info = "nu/<purpose>"`). `test` is for tests only. */
export type SecretPurpose = "smb" | "totp" | "smtp" | "sso" | "invitation" | "share-link" | "sign-in-identifier" | "test";

/** Binds an envelope to its cell: AAD = `table:column:rowId`, so a copy into another row or column fails. */
export interface EnvelopeAad {
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

/** AES-256-GCM envelope encryption and keyed hashes under the master key (threat model, T6). */
export interface Secrets {
  /** The master key's id (8 hex digits), stored in every envelope. Not secret. */
  readonly keyId: string;
  encrypt(purpose: SecretPurpose, aad: EnvelopeAad, plaintext: string): string;
  decrypt(purpose: SecretPurpose, aad: EnvelopeAad, envelope: string): string;
  /**
   * HMAC-SHA-256 of `data` under the purpose's key, base64url: the same input always gives the
   * same value, which can't be guessed without the master key. It changes with the master key.
   */
  mac(purpose: SecretPurpose, data: string): string;
}

export const MASTER_KEY_BYTES = 32;
export const ENVELOPE_VERSION = 1;
const KEY_ID_BYTES = 4;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_ID_BYTES;

/** Thrown when an envelope can't be decrypted; the message never holds key material or plaintext. */
export class SecretDecryptionError extends Error {
  override readonly name = "SecretDecryptionError";
}

/** `HMAC-SHA-256(masterKey, "nu/key-id")[0..4]`: a new key gets a new id with no stored state. */
export function masterKeyId(masterKey: Uint8Array): Buffer {
  return createHmac("sha256", masterKey).update("nu/key-id").digest().subarray(0, KEY_ID_BYTES);
}

export function createSecrets(masterKey: Uint8Array): Secrets {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new RangeError(`The master key must be ${MASTER_KEY_BYTES} bytes, got ${masterKey.length}`);
  }
  const keyId = masterKeyId(masterKey);
  const derived = new Map<SecretPurpose, Buffer>();
  const keyFor = (purpose: SecretPurpose): Buffer => {
    let key = derived.get(purpose);
    if (key === undefined) {
      key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), `nu/${purpose}`, 32));
      derived.set(purpose, key);
    }
    return key;
  };

  return {
    keyId: keyId.toString("hex"),

    encrypt(purpose, aad, plaintext) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadBytes(aad));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.of(ENVELOPE_VERSION), keyId, nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
    },

    decrypt(purpose, aad, envelope) {
      const bytes = Buffer.from(envelope, "base64url");
      if (bytes.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES) {
        throw new SecretDecryptionError("The envelope is too short");
      }
      const version = bytes[0];
      if (version !== ENVELOPE_VERSION) {
        throw new SecretDecryptionError(`Unsupported envelope version ${String(version)}`);
      }
      const envelopeKeyId = bytes.subarray(1, HEADER_BYTES);
      if (!envelopeKeyId.equals(keyId)) {
        throw new SecretDecryptionError(
          `The envelope was encrypted with another master key (key id ${envelopeKeyId.toString("hex")}, current ${keyId.toString("hex")})`,
        );
      }
      const nonce = bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
      const ciphertext = bytes.subarray(HEADER_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES);
      const tag = bytes.subarray(bytes.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(aadBytes(aad));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretDecryptionError(
          `The envelope for ${aad.table}.${aad.column} failed authentication (tampered, or stored in another row, column or purpose)`,
        );
      }
    },

    mac(purpose, data) {
      return createHmac("sha256", keyFor(purpose)).update(data, "utf8").digest("base64url");
    },
  };
}

function aadBytes(aad: EnvelopeAad): Buffer {
  return Buffer.from(`${aad.table}:${aad.column}:${aad.rowId}`, "utf8");
}

/** A column that holds envelopes, in a table whose rows are keyed by a text `id`. */
export interface EnvelopeColumn {
  readonly table: string;
  readonly column: string;
  readonly purpose: SecretPurpose;
}

/** Every envelope column, re-encrypted by `not-unreachable rotate-key`. Modules add theirs here. */
export const envelopeColumns: readonly EnvelopeColumn[] = [
  { table: "totp_credentials", column: "secret", purpose: "totp" },
  { table: "sso_providers", column: "client_secret", purpose: "sso" },
  { table: "sso_flows", column: "code_verifier", purpose: "sso" },
  { table: "invitations", column: "token", purpose: "invitation" },
  { table: "mail_settings", column: "password", purpose: "smtp" },
  { table: "share_links", column: "token", purpose: "share-link" },
  { table: "resources", column: "smb_password", purpose: "smb" },
];
