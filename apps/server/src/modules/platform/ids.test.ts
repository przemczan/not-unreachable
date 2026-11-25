import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("is a UUIDv7 with the RFC 9562 variant", () => {
    for (let i = 0; i < 100; i++) expect(newId()).toMatch(UUID_V7);
  });

  it("encodes the clock's milliseconds in the first 48 bits", () => {
    const at = new Date("2026-11-24T10:15:00.123Z");
    const id = newId({ now: () => at });
    expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(at.getTime());
  });

  it("sorts ids from later milliseconds after earlier ones", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const ids = Array.from({ length: 50 }, (_, i) => newId({ now: () => new Date(start + i * 1000) }));
    expect(ids.toSorted()).toEqual(ids);
  });

  it("differs within the same millisecond", () => {
    const at = new Date();
    const ids = new Set(Array.from({ length: 1000 }, () => newId({ now: () => at })));
    expect(ids.size).toBe(1000);
  });
});
