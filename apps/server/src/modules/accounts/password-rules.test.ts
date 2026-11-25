import { problemTypes } from "@not-unreachable/contracts";
import { describe, expect, it } from "vitest";
import { breachedPasswords } from "./breached-passwords.ts";
import { assertAcceptablePassword, passwordProblem } from "./index.ts";

describe("password rules (T1)", () => {
  it.each([
    [11, "too-short"],
    [12, null],
    [256, null],
    [257, "too-long"],
  ])("a password of %i characters: %s", (length, expected) => {
    expect(passwordProblem("x".repeat(length - 1) + "!")).toBe(expected);
  });

  it("refuses a long password on the breached list, and only with its exact case", () => {
    expect(breachedPasswords.has("qwertyuiop123")).toBe(true);
    expect(passwordProblem("qwertyuiop123")).toBe("breached");
    expect(passwordProblem("QWERTYUIOP123")).toBeNull();
  });

  it("has no composition rules", () => {
    expect(passwordProblem("correct horse battery staple")).toBeNull();
    expect(passwordProblem("lowercase only and spaces")).toBeNull();
  });

  it("bundles only entries the length rules would let through", () => {
    expect(breachedPasswords.size).toBeGreaterThan(1000);
    for (const entry of breachedPasswords) expect(entry.length).toBeGreaterThanOrEqual(12);
  });

  it("throws the 422 problems the routes answer", () => {
    expect(() => assertAcceptablePassword("qwertyuiop123")).toThrow(
      expect.objectContaining({ status: 422, type: problemTypes.breachedPassword }),
    );
    expect(() => assertAcceptablePassword("short")).toThrow(expect.objectContaining({ status: 422, type: problemTypes.validationFailed }));
    expect(() => assertAcceptablePassword("correct horse battery staple")).not.toThrow();
  });
});
