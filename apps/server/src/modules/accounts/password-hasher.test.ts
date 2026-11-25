import { describe, expect, it } from "vitest";
import { testPasswordHashing } from "../../test-support/index.ts";
import { systemTimers } from "../platform/index.ts";
import { createConcurrencyLimiter, createPasswordHasher, passwordHashingParameters, type PasswordHashingParameters } from "./index.ts";

const hasherWith = (parameters: PasswordHashingParameters) =>
  createPasswordHasher(parameters, createConcurrencyLimiter({ concurrency: 4, queueTimeoutMs: 5000, timers: systemTimers }));

describe("the password hasher", () => {
  it("uses the stack.md parameters in the app", () => {
    expect(passwordHashingParameters).toEqual({ memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32 });
  });

  it("makes an argon2id PHC string with a 16-byte salt and a 32-byte hash, and verifies it", async () => {
    const hasher = hasherWith(testPasswordHashing);
    const phc = await hasher.hash("correct horse battery staple");
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=64,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    await expect(hasher.verify(phc, "correct horse battery staple")).resolves.toBe(true);
    await expect(hasher.verify(phc, "correct horse battery stapler")).resolves.toBe(false);
    await expect(hasher.verify("not a hash", "anything")).resolves.toBe(false);
  });

  it("needs a rehash when the stored parameters differ from the current ones", async () => {
    const older = await hasherWith({ ...testPasswordHashing, memoryCost: 128 }).hash("correct horse battery staple");
    const hasher = hasherWith(testPasswordHashing);
    expect(hasher.needsRehash(older)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash("correct horse battery staple"))).toBe(false);
    expect(hasher.needsRehash("$argon2i$v=19$m=64,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g")).toBe(true);
    expect(hasher.needsRehash("garbage")).toBe(true);
  });

  it("verifies a dummy hash for a missing account, made once", async () => {
    const hasher = hasherWith(testPasswordHashing);
    await expect(hasher.verifyDummy("anything at all")).resolves.toBeUndefined();
    await expect(hasher.verifyDummy("anything at all")).resolves.toBeUndefined();
  });
});
