import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test-support/index.ts";
import { redactUrl } from "./logger.ts";

describe("redactUrl", () => {
  it.each([
    ["/s/abcDEF123", "/s/<redacted>"],
    ["/s/abcDEF123/file.txt", "/s/<redacted>/file.txt"],
    ["/s/abcDEF123?download=1", "/s/<redacted>?download=1"],
    ["/api/v1/public/share-links/abcDEF123", "/api/v1/public/share-links/<redacted>"],
    ["/api/v1/public/share-links/abcDEF123/files?path=a", "/api/v1/public/share-links/<redacted>/files?path=a"],
    ["/api/v1/public/share-links/abcDEF123?x=1", "/api/v1/public/share-links/<redacted>?x=1"],
    ["/%73/abcDEF123/file.txt", "/s/<redacted>/file.txt"],
    ["/api/v1/public/%73hare-links/abcDEF123", "/api/v1/public/share-links/<redacted>"],
    ["/%73/abcDEF123%zz", "/s/<redacted>"],
    ["/invitation/abcDEF123", "/invitation/<redacted>"],
    ["/relink/abcDEF123?error=sign-in-failed", "/relink/<redacted>?error=sign-in-failed"],
    ["/api/v1/invitations/abcDEF123/accept", "/api/v1/invitations/<redacted>/accept"],
    ["/api/v1/relink/abcDEF123/start", "/api/v1/relink/<redacted>/start"],
    ["/%69nvitation/abcDEF123", "/invitation/<redacted>"],
    ["/api/v1/sso/p1/callback?code=abc&state=def", "/api/v1/sso/p1/callback?<redacted>"],
    ["/api/v1/sso/p1/callback", "/api/v1/sso/p1/callback"],
    ["/api/v1/admin/invitations/01900000-0000-7000-8000-000000000000", "/api/v1/admin/invitations/01900000-0000-7000-8000-000000000000"],
    ["/%2Fs/abc", "/%2Fs/abc"],
    ["/api/v1/files/s/abc", "/api/v1/files/s/abc"],
    ["/settings", "/settings"],
  ])("%s → %s", (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });
});

describe("createLogger", () => {
  it("redacts auth headers, set-cookie and secret fields at several depths", () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        req: { headers: { cookie: "nu_session=leak-cookie", authorization: "Bearer leak-bearer", accept: "text/html" } },
        res: { headers: { "set-cookie": "nu_session=leak-setcookie" } },
        password: "leak-p0",
        body: { password: "leak-p1", code: "leak-123456", secret: "leak-s1", token: "leak-t1", name: "kept" },
        outer: { body: { password: "leak-p2", token: "leak-t2" } },
        deep: { a: { b: { secret: "leak-s3" } } },
      },
      "request",
    );
    const [line] = lines();
    const text = JSON.stringify(line);
    for (const value of [
      "leak-cookie",
      "leak-bearer",
      "leak-setcookie",
      "leak-p0",
      "leak-p1",
      "leak-123456",
      "leak-s1",
      "leak-t1",
      "leak-p2",
      "leak-t2",
      "leak-s3",
    ]) {
      expect(text).not.toContain(value);
    }
    expect(line).toMatchObject({
      msg: "request",
      res: { headers: { "set-cookie": "[Redacted]" } },
      password: "[Redacted]",
      body: { password: "[Redacted]", code: "[Redacted]", secret: "[Redacted]", token: "[Redacted]", name: "kept" },
      outer: { body: { password: "[Redacted]", token: "[Redacted]" } },
    });
  });

  it("logs a Fastify-like request as method, redacted url and remote address only", () => {
    const { logger, lines } = captureLogger();
    const request = {
      method: "GET",
      url: "/s/secretShareToken/report.pdf",
      ip: "203.0.113.7",
      headers: { cookie: "nu_session=abc" },
      body: { password: "hunter2" },
    };
    logger.info({ req: request }, "incoming request");
    const [line] = lines();
    expect(line?.["req"]).toEqual({ method: "GET", url: "/s/<redacted>/report.pdf", remoteAddress: "203.0.113.7" });
    expect(JSON.stringify(line)).not.toContain("secretShareToken");
    expect(JSON.stringify(line)).not.toContain("hunter2");
  });

  it("honours the log level", () => {
    const { logger, lines } = captureLogger("warn");
    logger.info("hidden");
    logger.warn("shown");
    expect(lines().map((line) => line["msg"])).toEqual(["shown"]);
  });
});
