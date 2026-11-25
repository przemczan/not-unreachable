import { randomBytes, timingSafeEqual } from "node:crypto";
import { TOTP_CODE_DIGITS } from "@not-unreachable/contracts";
import { Secret, TOTP } from "otpauth";
import { toString as qrCodeSvg } from "qrcode";

/** stack.md, "TOTP: otpauth": RFC 6238 with what every authenticator app supports. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ALGORITHM = "SHA1";
/** Codes of the step before and after the current one pass too, for clock drift. */
export const TOTP_WINDOW_STEPS = 1;
const SECRET_BYTES = 20;

/** A new random key, in base32 as apps and the envelope hold it. */
export function newTotpSecret(): string {
  return new Secret({ buffer: Uint8Array.from(randomBytes(SECRET_BYTES)).buffer }).base32;
}

function totpFor(secret: string, label = "", issuer = ""): TOTP {
  return new TOTP({
    issuer,
    label,
    issuerInLabel: issuer !== "",
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_CODE_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  });
}

/** The 30-second step `at` falls in. */
export function totpStepAt(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code an app shows during `step`. */
export function totpCodeForStep(secret: string, step: number): string {
  return totpFor(secret).generate({ timestamp: step * TOTP_PERIOD_SECONDS * 1000 });
}

/** Compares two codes in constant time; codes of another length never match. */
export function codesEqual(expected: string, given: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(given, "utf8");
  // Compare equal-length buffers either way, so the time doesn't tell the length apart.
  const same = timingSafeEqual(left, left.length === right.length ? right : left);
  return same && left.length === right.length;
}

/**
 * The step `code` is valid for at `now`, within ±1 step and after `lastUsedStep`, so a code
 * passes once; undefined when none. Every step of the window is compared, matched or not.
 */
export function matchTotpStep(secret: string, code: string, now: Date, lastUsedStep: number | null): number | undefined {
  const current = totpStepAt(now);
  let matched: number | undefined;
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step += 1) {
    const equal = codesEqual(totpCodeForStep(secret, step), code);
    if (equal && matched === undefined && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

/** The `otpauth://` URI apps scan, drawn as an SVG data URL. */
export async function totpQrCode(secret: string, label: string, issuer: string): Promise<string> {
  const svg = await qrCodeSvg(totpFor(secret, label, issuer).toString(), { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
