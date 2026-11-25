import { describe, expect, it } from "vitest";
import { landingPath, safeNextPath } from "./safe-next.ts";

describe("safeNextPath", () => {
  it.each([
    ["/admin/audit-log", "admin", "/admin/audit-log"],
    ["/admin", "admin", "/admin"],
    ["/admin/settings/security?tab=1#top", "admin", "/admin/settings/security?tab=1#top"],
    ["/settings/sessions", "admin", "/settings/sessions"],
    ["/files", "user", "/files"],
    ["/files/photos", "user", "/files/photos"],
    ["/settings/profile", "user", "/settings/profile"],
    ["/s/0123456789abcdefghijklmnopqrstuvwxyzABCDEFG", "admin", "/s/0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"],
    ["/s/0123456789abcdefghijklmnopqrstuvwxyzABCDEFG", "user", "/s/0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"],
    ["/s/abc-_DEF?path=2026%2Fphotos", "user", "/s/abc-_DEF?path=2026%2Fphotos"],
  ] as const)("accepts %s for the %s", (value, role, expected) => {
    expect(safeNextPath(value, role)).toBe(expected);
  });

  it.each([
    "//evil",
    "//evil.example/admin",
    "/\\evil",
    "\\\\evil",
    "https:",
    "https://evil",
    "https://evil.example/admin",
    "javascript:alert(1)",
    "/%2F%2Fevil",
    "/%5Cevil",
    "/admin%0d%0aSet-Cookie:x",
    "/admin\n",
    "admin",
    "/sign-in",
    "/setup",
    "/",
    "/administrator",
    "/admin/../sign-in",
    "/s",
    "/s/",
    "/s/../sign-in",
    "/share/x",
    "//s/x",
    "/files",
    "/%E0%A4%A",
    "",
  ])("sends the admin to the landing page for %j", (value) => {
    expect(safeNextPath(value, "admin")).toBe("/admin");
  });

  it.each(["/admin", "/admin/audit-log", "//evil", "/sign-in"])("sends a user to /files for %j", (value) => {
    expect(safeNextPath(value, "user")).toBe("/files");
  });

  it("falls back to the landing page without a value", () => {
    expect(safeNextPath(null, "admin")).toBe(landingPath("admin"));
    expect(safeNextPath(undefined, "user")).toBe(landingPath("user"));
  });
});
