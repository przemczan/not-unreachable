import { randomInt } from "node:crypto";
import { RECOVERY_CODE_COUNT, RECOVERY_CODE_LENGTH } from "@not-unreachable/contracts";

/** RFC 4648 base32: no 0, 1, 8 or 9, so a code read aloud or typed has fewer look-alikes. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const GROUP_LENGTH = RECOVERY_CODE_LENGTH / 2;
const STORED_CODE = new RegExp(`^[${BASE32_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`);

/** One new code, 10 base32 characters (50 bits), uniformly random. */
export function newRecoveryCode(): string {
  let code = "";
  for (let index = 0; index < RECOVERY_CODE_LENGTH; index += 1) code += BASE32_ALPHABET[randomInt(BASE32_ALPHABET.length)];
  return code;
}

/** A new set of distinct codes. */
export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(newRecoveryCode());
  return [...codes];
}

/** As the admin is shown it: two groups of 5, such as `ABCDE-FGH23`. */
export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, GROUP_LENGTH)}-${code.slice(GROUP_LENGTH)}`;
}

/** A typed code as stored: upper case, without dashes and spaces; undefined when it can't be one. */
export function normalizeRecoveryCode(typed: string): string | undefined {
  const code = typed.replaceAll(/[\s-]/g, "").toUpperCase();
  return STORED_CODE.test(code) ? code : undefined;
}
