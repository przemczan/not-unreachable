import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, problemTypes } from "@not-unreachable/contracts";
import { HttpProblem } from "../../http/index.ts";
import { breachedPasswords } from "./breached-passwords.ts";

export type PasswordProblem = "too-short" | "too-long" | "breached";

/** Threat model, T1: 12–256 characters (as the contract counts them), no composition rules, not on the breached list. */
export function passwordProblem(password: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "too-short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too-long";
  if (breachedPasswords.has(password)) return "breached";
  return null;
}

/** Throws the 422 a new password that breaks the rules gets. */
export function assertAcceptablePassword(password: string): void {
  const found = passwordProblem(password);
  if (found === "breached") {
    throw new HttpProblem(422, problemTypes.breachedPassword, "This password is known from data breaches. Choose another one.");
  }
  if (found !== null) {
    throw new HttpProblem(
      422,
      problemTypes.validationFailed,
      `A password has ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
    );
  }
}
