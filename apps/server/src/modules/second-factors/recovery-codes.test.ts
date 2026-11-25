import { RECOVERY_CODE_COUNT } from "@not-unreachable/contracts";
import { describe, expect, it } from "vitest";
import { formatRecoveryCode, newRecoveryCode, newRecoveryCodes, normalizeRecoveryCode } from "./recovery-codes.ts";

describe("recovery codes", () => {
  it("are 10 base32 characters", () => {
    for (let index = 0; index < 50; index += 1) expect(newRecoveryCode()).toMatch(/^[A-Z2-7]{10}$/);
  });

  it("come 10 to a set, all different", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it("are shown as two groups of 5", () => {
    expect(formatRecoveryCode("ABCDEFGH23")).toBe("ABCDE-FGH23");
  });

  it("are read back in any case, with or without the dash and spaces", () => {
    for (const typed of ["ABCDE-FGH23", "abcde-fgh23", " abcde fgh23 ", "ABCDEFGH23"]) {
      expect(normalizeRecoveryCode(typed)).toBe("ABCDEFGH23");
    }
  });

  it("refuse what can't be a code", () => {
    for (const typed of ["ABCDE-FGH2", "ABCDE-FGH234", "ABCDE-FGH01", "ABCDE_FGH23", ""]) {
      expect(normalizeRecoveryCode(typed)).toBeUndefined();
    }
  });
});
