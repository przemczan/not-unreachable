import { describe, expect, it } from "vitest";
import { z } from "zod";
import { newId } from "./ids.ts";

describe("newId", () => {
  it("makes UUIDv7s that carry the time and differ each time", () => {
    const now = new Date("2026-11-25T10:00:00.000Z");
    const first = newId(now);
    expect(z.uuidv7().safeParse(first).success).toBe(true);
    expect(Number.parseInt(first.replaceAll("-", "").slice(0, 12), 16)).toBe(now.getTime());
    expect(newId(now)).not.toBe(first);
  });
});
