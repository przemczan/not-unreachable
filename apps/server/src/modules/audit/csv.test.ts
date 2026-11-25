import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv.ts";

describe("csvCell", () => {
  it.each([
    ["plain", "plain"],
    ["", ""],
    [null, ""],
    ["=1+1", "'=1+1"],
    ["+x", "'+x"],
    ["-x", "'-x"],
    ["@x", "'@x"],
    ["\tx", "'\tx"],
    ["\rx", '"\'\rx"'],
    ['=HYPERLINK("http://evil","x")', '"\'=HYPERLINK(""http://evil"",""x"")"'],
    ['say "hi"', '"say ""hi"""'],
    ["a,b", '"a,b"'],
    ["line\nbreak", '"line\nbreak"'],
    ["line\r\nbreak", '"line\r\nbreak"'],
    ["1-1", "1-1"],
    ["a=b", "a=b"],
  ])("%j becomes %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});

describe("toCsv", () => {
  it("joins cells with commas and ends each row with CRLF", () => {
    expect(
      toCsv([
        ["a", "b"],
        ["c,d", null],
      ]),
    ).toBe('a,b\r\n"c,d",\r\n');
  });

  it("answers nothing for no rows", () => {
    expect(toCsv([])).toBe("");
  });
});
