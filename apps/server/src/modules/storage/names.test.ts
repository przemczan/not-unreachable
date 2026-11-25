import { describe, expect, it } from "vitest";
import { checkName, type NameRefusal } from "./index.ts";

describe("checkName (T5 step 7)", () => {
  it.each<[string, NameRefusal]>([
    ["", "empty"],
    [".", "dot"],
    ["..", "dot"],
    ["a/b", "slash"],
    ["/", "slash"],
    ["a\u0000b", "control-character"],
    ["tab\there", "control-character"],
    ["del\u007f", "control-character"],
    ["a\\b", "reserved-character"],
    ...'<>:"|?*'.split("").map((character): [string, NameRefusal] => [`a${character}b`, "reserved-character"]),
    ["\ud800", "reserved-character"],
    ["a".repeat(256), "too-long"],
    ["é".repeat(128), "too-long"],
    ["report.", "trailing-dot-or-space"],
    ["report ", "trailing-dot-or-space"],
    ["...", "trailing-dot-or-space"],
    ["CON", "reserved-name"],
    ["con", "reserved-name"],
    ["con.txt", "reserved-name"],
    ["Con.tar.gz", "reserved-name"],
    ["CON .txt", "reserved-name"],
    ["PRN", "reserved-name"],
    ["aux.log", "reserved-name"],
    ["NUL", "reserved-name"],
    ["COM1.log", "reserved-name"],
    ["com9", "reserved-name"],
    ["LPT9", "reserved-name"],
    ["lpt1.txt", "reserved-name"],
  ])("refuses %j (%s)", (name, reason) => {
    expect(checkName(name)).toEqual({ ok: false, reason });
  });

  it.each([
    "report.pdf",
    ".bashrc",
    "a".repeat(255),
    "COM0",
    "COM10",
    "LPT",
    "console.txt",
    "nul-file",
    "my con.txt",
    "%2e%2e",
    "img src=x onerror=alert(1).txt",
    "名前.txt",
  ])("accepts %j", (name) => {
    expect(checkName(name)).toEqual({ ok: true, name });
  });

  it("answers the name in NFC", () => {
    expect(checkName("Café.txt")).toEqual({ ok: true, name: "Café.txt" });
  });
});
