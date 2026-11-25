import { describe, expect, it } from "vitest";
import { formatBytes, formatBytesOf } from "./formatBytes.ts";

describe("formatBytes", () => {
  it("shows a size in decimal units with at most one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(10_000_000_000)).toBe("10 GB");
  });

  it("shows an amount of a total in the total's unit", () => {
    expect(formatBytesOf(4_200_000_000, 10_000_000_000)).toBe("4.2 / 10 GB");
    expect(formatBytesOf(512_000_000, 10_000_000_000)).toBe("0.5 / 10 GB");
  });
});
