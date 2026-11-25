import { timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { codesEqual, matchTotpStep, newTotpSecret, totpCodeForStep, totpQrCode, totpStepAt, TOTP_PERIOD_SECONDS } from "./totp.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, timingSafeEqual: vi.fn<typeof crypto.timingSafeEqual>(crypto.timingSafeEqual) };
});

const secret = newTotpSecret();
const now = new Date("2026-11-24T10:15:10.000Z");
const current = totpStepAt(now);
const codeAt = (offset: number): string => totpCodeForStep(secret, current + offset);

describe("TOTP", () => {
  it("makes a 160-bit base32 key", () => {
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(newTotpSecret()).not.toBe(secret);
  });

  it("counts 30-second steps", () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(totpStepAt(new Date(30_000 * 7))).toBe(7);
    expect(totpStepAt(new Date(30_000 * 8 - 1))).toBe(7);
  });

  it("matches the RFC 6238 SHA-1 test vector", () => {
    // RFC 6238, appendix B: the ASCII key "12345678901234567890", T = 59 s, 8 digits 94287082.
    expect(totpCodeForStep("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1)).toBe("287082");
  });

  it("accepts the step before, the current one and the one after, and no other", () => {
    expect(matchTotpStep(secret, codeAt(-1), now, null)).toBe(current - 1);
    expect(matchTotpStep(secret, codeAt(0), now, null)).toBe(current);
    expect(matchTotpStep(secret, codeAt(1), now, null)).toBe(current + 1);
    expect(matchTotpStep(secret, codeAt(-2), now, null)).toBeUndefined();
    expect(matchTotpStep(secret, codeAt(2), now, null)).toBeUndefined();
  });

  it("accepts each step only once: never the last used step or one before it", () => {
    expect(matchTotpStep(secret, codeAt(0), now, current)).toBeUndefined();
    expect(matchTotpStep(secret, codeAt(-1), now, current)).toBeUndefined();
    expect(matchTotpStep(secret, codeAt(1), now, current)).toBe(current + 1);
    expect(matchTotpStep(secret, codeAt(0), now, current - 1)).toBe(current);
  });

  it("refuses codes of another key, length or form", () => {
    expect(matchTotpStep(newTotpSecret(), codeAt(0), now, null)).toBeUndefined();
    expect(matchTotpStep(secret, codeAt(0).slice(1), now, null)).toBeUndefined();
    expect(matchTotpStep(secret, `${codeAt(0)}0`, now, null)).toBeUndefined();
    expect(matchTotpStep(secret, "", now, null)).toBeUndefined();
  });

  it("draws the otpauth URI as an SVG data URL", async () => {
    const qrCode = await totpQrCode(secret, "root.admin", "NotUnreachable");
    expect(qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(qrCode.split(",")[1] ?? "", "base64").toString("utf8")).toContain("<svg");
  });
});

describe("codesEqual", () => {
  it("is true only for the same code", () => {
    expect(codesEqual("123456", "123456")).toBe(true);
    expect(codesEqual("123456", "123457")).toBe(false);
    expect(codesEqual("123456", "12345")).toBe(false);
    expect(codesEqual("123456", "1234567")).toBe(false);
    expect(codesEqual("123456", "")).toBe(false);
  });

  it("always compares through crypto.timingSafeEqual, over buffers of the same length", () => {
    const compare = vi.mocked(timingSafeEqual);
    compare.mockClear();
    for (const given of ["123456", "000000", "12345", "1234567", ""]) codesEqual("123456", given);
    expect(compare).toHaveBeenCalledTimes(5);
    for (const [left, right] of compare.mock.calls) expect(left.byteLength).toBe(right.byteLength);
  });
});
