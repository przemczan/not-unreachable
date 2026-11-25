import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

/** 32 random bytes, base64url without padding: 43 characters (threat model, T2). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A new secret token, for a session cookie or a one-time link. */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** What the database holds instead of a token: its SHA-256, hex. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
