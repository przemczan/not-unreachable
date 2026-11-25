import { describe, expect, it } from "vitest";
import { absoluteUrl } from "./absolute-url.ts";

const config = { publicOrigin: "https://files.example.com" };

describe("absoluteUrl (T15)", () => {
  it("builds URLs on PUBLIC_ORIGIN", () => {
    expect(absoluteUrl(config, "/invitations/abc?x=1")).toBe("https://files.example.com/invitations/abc?x=1");
  });

  it.each(["//evil.example/x", "/\\evil.example", "https://evil.example/", "relative", ""])("refuses %j", (path) => {
    expect(() => absoluteUrl(config, path)).toThrow(RangeError);
  });
});
