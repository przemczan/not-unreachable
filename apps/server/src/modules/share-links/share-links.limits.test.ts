import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { problemTypes, routes, shareLinksPageSchema } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildShareLinksTestApp, expectProblem, viaProxy, type ShareLinksTestApp } from "../../test-support/index.ts";
import { rateLimitKey } from "../../http/rate-limit.ts";
import { MINUTE_MS, newToken } from "../platform/index.ts";
import { settingsRegistry } from "../settings/index.ts";
import { SHARE_TOKEN_LIMIT, WRONG_PASSWORDS_PER_IP_WINDOW_MS } from "./limits.ts";

const defaults = settingsRegistry.shareLinkLimits.default;
const INVALID_TOKENS_MAX = defaults.invalidTokensPerIpPerMinute;
const INVALID_TOKENS_BLOCK_MS = defaults.invalidTokenBlockMinutes * MINUTE_MS;
const WRONG_PASSWORDS_PER_IP_MAX = defaults.wrongPasswordsPerIpPer15Minutes;
const WRONG_PASSWORDS_PER_LINK_MAX = defaults.wrongPasswordsPerLinkPerHour;
const SHARE_LINK_LOCK_MS = defaults.lockMinutes * MINUTE_MS;
const CONCURRENT_DOWNLOADS_MAX = defaults.concurrentDownloadsPerIp;

let app: ShareLinksTestApp;

beforeEach(async () => {
  app = await buildShareLinksTestApp();
});
afterEach(async () => {
  await app.close();
});

const HOUR_MS = 60 * MINUTE_MS;
const linkPassword = "open sesame 42";

const describeLink = (token: string, ip: string) => app.asPublic(routes.getPublicShareLink, token, { ip });
const unlock = (token: string, password: string, ip: string) => app.asPublic(routes.unlockShareLink, token, { ip, payload: { password } });

describe("invalid tokens", () => {
  it("block an IP for 15 minutes after 20 in a minute, on the whole public share API", async () => {
    const ip = "198.51.100.10";
    const { token } = await app.createLink({ path: "docs" });
    expect(INVALID_TOKENS_MAX).toBe(20);
    expect(INVALID_TOKENS_BLOCK_MS).toBe(15 * MINUTE_MS);
    for (let attempt = 0; attempt < INVALID_TOKENS_MAX; attempt += 1) {
      expectProblem(await describeLink(newToken(), ip), 404, problemTypes.shareLinkInvalid);
    }
    expect((await describeLink(token, ip)).statusCode).toBe(200);
    const blocked = await describeLink(newToken(), ip);
    expectProblem(blocked, 429, problemTypes.rateLimited);
    expect(blocked.headers["retry-after"]).toBe("900");

    // Every route of the token, a valid one included, and only this IP.
    expectProblem(await describeLink(token, ip), 429, problemTypes.rateLimited);
    expectProblem(await app.asPublic(routes.listShareLinkEntries, token, { ip }), 429, problemTypes.rateLimited);
    expectProblem(
      await app.asPublic(routes.downloadShareLinkContent, token, { ip, query: { path: "report.pdf" } }),
      429,
      problemTypes.rateLimited,
    );
    expectProblem(await unlock(token, linkPassword, ip), 429, problemTypes.rateLimited);
    expect((await describeLink(token, "198.51.100.11")).statusCode).toBe(200);
    expect((await app.asAdmin(routes.listShareLinks, { headers: { "x-forwarded-for": ip } })).statusCode).toBe(200);

    app.test.clock.advance(15 * MINUTE_MS - 1000);
    const stillBlocked = await describeLink(token, ip);
    expectProblem(stillBlocked, 429, problemTypes.rateLimited);
    expect(stillBlocked.headers["retry-after"]).toBe("1");
    app.test.clock.advance(1000);
    expect((await describeLink(token, ip)).statusCode).toBe(200);

    expect(app.test.audited("rate-limit.triggered").map((event) => [event.ip, event.actorKind, event.outcome, event.details])).toEqual([
      [ip, "anonymous", "denied", { limit: SHARE_TOKEN_LIMIT, key: ip }],
    ]);
  });

  it("are counted in a sliding minute", async () => {
    const ip = "198.51.100.12";
    for (let attempt = 0; attempt < INVALID_TOKENS_MAX; attempt += 1) expect((await describeLink(newToken(), ip)).statusCode).toBe(404);
    app.test.clock.advance(MINUTE_MS);
    for (let attempt = 0; attempt < INVALID_TOKENS_MAX; attempt += 1) expect((await describeLink(newToken(), ip)).statusCode).toBe(404);
    expect(app.test.audited("rate-limit.triggered")).toEqual([]);
  });

  it("group IPv6 addresses by /64, and audit each block once", async () => {
    const first = "2001:db8:1:2::1";
    const sameNetwork = "2001:db8:1:2:ffff:ffff:ffff:fffe";
    const otherNetwork = "2001:db8:1:3::1";
    for (let attempt = 0; attempt < INVALID_TOKENS_MAX / 2; attempt += 1) {
      expect((await describeLink(newToken(), first)).statusCode).toBe(404);
      expect((await describeLink(newToken(), sameNetwork)).statusCode).toBe(404);
    }
    expectProblem(await describeLink(newToken(), first), 429, problemTypes.rateLimited);
    expectProblem(await describeLink(newToken(), sameNetwork), 429, problemTypes.rateLimited);
    expect((await describeLink(newToken(), otherNetwork)).statusCode).toBe(404);
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await describeLink(newToken(), sameNetwork)).statusCode).toBe(429);

    const key = rateLimitKey(first);
    expect(key).toBe(rateLimitKey(sameNetwork));
    expect(key).not.toBe(rateLimitKey(otherNetwork));
    expect(app.test.audited("rate-limit.triggered").map((event) => event.details)).toEqual([{ limit: SHARE_TOKEN_LIMIT, key }]);

    // Once the block is over, the next one is audited again.
    app.test.clock.advance(INVALID_TOKENS_BLOCK_MS);
    for (let attempt = 0; attempt < INVALID_TOKENS_MAX; attempt += 1) expect((await describeLink(newToken(), first)).statusCode).toBe(404);
    expect((await describeLink(newToken(), sameNetwork)).statusCode).toBe(429);
    expect(app.test.audited("rate-limit.triggered")).toHaveLength(2);
  });
});

const listed = async (id: string) =>
  shareLinksPageSchema.parse((await app.asAdmin(routes.listShareLinks)).json()).shareLinks.find((link) => link.id === id);

describe("wrong passwords", () => {
  it("lock the link for an hour after 5 from one IP within 15 minutes", async () => {
    const { token, shareLink } = await app.createLink({ path: "single.txt", password: linkPassword });
    const other = await app.createLink({ path: "single.txt", password: linkPassword });
    const ip = "203.0.113.20";
    expect(WRONG_PASSWORDS_PER_IP_MAX).toBe(5);
    for (let attempt = 1; attempt < WRONG_PASSWORDS_PER_IP_MAX; attempt += 1) {
      expectProblem(await unlock(token, `wrong ${attempt}`, ip), 401, problemTypes.shareLinkPasswordWrong);
    }
    // Another link's count is its own.
    expectProblem(await unlock(other.token, "wrong", ip), 401, problemTypes.shareLinkPasswordWrong);

    const locking = await unlock(token, "wrong 5", ip);
    expectProblem(locking, 429, problemTypes.tooManyAttempts);
    expect(locking.headers["retry-after"]).toBe(String(SHARE_LINK_LOCK_MS / 1000));
    const lockedUntil = new Date(app.test.clock.now().getTime() + HOUR_MS).toISOString();
    expect(app.row(shareLink.id)["locked_until"]).toBe(lockedUntil);
    expect(await listed(shareLink.id)).toMatchObject({ locked: true, lockedUntil, state: "active" });
    expect(await listed(other.shareLink.id)).toMatchObject({ locked: false, lockedUntil: null });

    expect(app.test.audited("share-link.locked").map((event) => [event.targetId, event.actorKind, event.ip, event.details])).toEqual([
      [shareLink.id, "anonymous", ip, { reason: "per-ip", lockedUntil }],
    ]);
    const failed = app.test.audited("share-link.password-failed").filter((event) => event.targetId === shareLink.id);
    expect(failed).toHaveLength(WRONG_PASSWORDS_PER_IP_MAX);
    expect(failed.filter((event) => event.details["limitReached"] === true)).toHaveLength(1);

    // Locked: even the right password, from any IP, until the hour is over; the downloads stay open.
    app.test.clock.advance(HOUR_MS - 1000);
    const locked = await unlock(token, linkPassword, "203.0.113.99");
    expectProblem(locked, 429, problemTypes.tooManyAttempts);
    expect(locked.headers["retry-after"]).toBe("1");
    expect(app.test.audited("share-link.password-failed").filter((event) => event.targetId === shareLink.id)).toHaveLength(5);
    app.test.clock.advance(1000);
    expect((await unlock(token, linkPassword, ip)).statusCode).toBe(204);
    expect(await listed(shareLink.id)).toMatchObject({ locked: false, lockedUntil: null });
  });

  it("are counted per IP within 15 minutes", async () => {
    const { token } = await app.createLink({ path: "single.txt", password: linkPassword });
    const ip = "203.0.113.21";
    for (let attempt = 1; attempt < WRONG_PASSWORDS_PER_IP_MAX; attempt += 1)
      expect((await unlock(token, "wrong", ip)).statusCode).toBe(401);
    app.test.clock.advance(WRONG_PASSWORDS_PER_IP_WINDOW_MS);
    for (let attempt = 1; attempt < WRONG_PASSWORDS_PER_IP_MAX; attempt += 1)
      expect((await unlock(token, "wrong", ip)).statusCode).toBe(401);
    expect(app.test.audited("share-link.locked")).toEqual([]);
  });

  it("lock the link after 50 within an hour from any IPs", async () => {
    const { token, shareLink } = await app.createLink({ path: "single.txt", password: linkPassword });
    expect(WRONG_PASSWORDS_PER_LINK_MAX).toBe(50);
    const perIp = WRONG_PASSWORDS_PER_IP_MAX - 1;
    const ipOf = (attempt: number) => `198.18.0.${Math.floor(attempt / perIp) + 1}`;
    for (let attempt = 0; attempt < WRONG_PASSWORDS_PER_LINK_MAX - 1; attempt += 1) {
      expect((await unlock(token, "wrong", ipOf(attempt))).statusCode).toBe(401);
      // Within the hour, never within one IP's 15 minutes.
      app.test.clock.advance(MINUTE_MS);
    }
    expectProblem(await unlock(token, "wrong", ipOf(WRONG_PASSWORDS_PER_LINK_MAX - 1)), 429, problemTypes.tooManyAttempts);
    expect(app.test.audited("share-link.locked").map((event) => event.details["reason"])).toEqual(["per-link"]);
    expect(await listed(shareLink.id)).toMatchObject({ locked: true });
  });
});

/** A big file (sparse), so a download not read stays open, held by backpressure. */
const bigSize = 64 * 1024 * 1024;

/** Starts a download whose body is not read yet. */
const startDownload = (token: string, ip: string) =>
  app.test.app.inject({
    method: "GET",
    url: `/api/v1/public/share-links/${token}/content`,
    headers: { ...viaProxy, "x-forwarded-for": ip },
    payloadAsStream: true,
  });

async function drain(response: LightMyRequestResponse): Promise<number> {
  let bytes = 0;
  for await (const chunk of response.stream()) bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : 0;
  return bytes;
}

/** `expectProblem`, but its stack check would take the title's "downloads at once" for a stack frame. */
const expectTooManyDownloads = (response: LightMyRequestResponse): void => {
  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual({ type: problemTypes.tooManyDownloads, title: "Too many downloads at once", status: 429 });
  expect(response.headers["retry-after"]).toBe("5");
};

/** What a browser closing the connection mid-download does to the server's response. */
const abort = (response: LightMyRequestResponse): void => {
  response.raw.res.destroy();
  response.stream().destroy();
};

describe("concurrent downloads", () => {
  it("are at most 4 per link per IP, a slot coming back once a download ends or is aborted", async () => {
    const big = join(app.resourceDir, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, bigSize);
    const { token } = await app.createLink({ path: "big.bin" });
    const other = await app.createLink({ path: "big.bin" });
    const ip = "198.51.100.30";
    expect(CONCURRENT_DOWNLOADS_MAX).toBe(4);

    const held: LightMyRequestResponse[] = [];
    for (let download = 0; download < CONCURRENT_DOWNLOADS_MAX; download += 1) {
      const response = await startDownload(token, ip);
      expect(response.statusCode).toBe(200);
      held.push(response);
    }
    try {
      expectTooManyDownloads(await app.asPublic(routes.downloadShareLinkContent, token, { ip }));
      // Another IP, or another link, has slots of its own.
      const elsewhere = await startDownload(token, "198.51.100.31");
      expect(elsewhere.statusCode).toBe(200);
      abort(elsewhere);
      const otherLink = await startDownload(other.token, ip);
      expect(otherLink.statusCode).toBe(200);
      abort(otherLink);

      // A finished download gives its slot back.
      const finished = held.shift();
      expect(finished === undefined ? 0 : await drain(finished)).toBe(bigSize);
      await new Promise((resolve) => setImmediate(resolve));
      const next = await startDownload(token, ip);
      expect(next.statusCode).toBe(200);
      held.push(next);
      expectTooManyDownloads(await app.asPublic(routes.downloadShareLinkContent, token, { ip }));

      // So does an aborted one.
      const aborted = held.shift();
      if (aborted !== undefined) abort(aborted);
      await new Promise((resolve) => setImmediate(resolve));
      const afterAbort = await startDownload(token, ip);
      expect(afterAbort.statusCode).toBe(200);
      held.push(afterAbort);
      expectTooManyDownloads(await app.asPublic(routes.downloadShareLinkContent, token, { ip }));
    } finally {
      for (const response of held) abort(response);
    }
  });

  it("give the slot back when the download is refused", async () => {
    const { token } = await app.createLink({ path: "docs/report.pdf" });
    const ip = "198.51.100.32";
    for (let attempt = 0; attempt < CONCURRENT_DOWNLOADS_MAX + 2; attempt += 1) {
      expectProblem(
        await app.asPublic(routes.downloadShareLinkContent, token, { ip, headers: { range: "bytes=1000-" } }),
        416,
        problemTypes.rangeNotSatisfiable,
      );
    }
    expect((await app.asPublic(routes.downloadShareLinkContent, token, { ip })).statusCode).toBe(200);
  });
});

describe("the shareLinkLimits setting", () => {
  it("changes every limit on the next request", async () => {
    app.test.settings.set(
      "shareLinkLimits",
      {
        invalidTokensPerIpPerMinute: 2,
        invalidTokenBlockMinutes: 1,
        wrongPasswordsPerIpPer15Minutes: 2,
        wrongPasswordsPerLinkPerHour: 50,
        lockMinutes: 5,
        concurrentDownloadsPerIp: 1,
      },
      null,
    );

    const blockedIp = "198.51.100.40";
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await describeLink(newToken(), blockedIp)).statusCode).toBe(404);
    const blocked = await describeLink(newToken(), blockedIp);
    expectProblem(blocked, 429, problemTypes.rateLimited);
    expect(blocked.headers["retry-after"]).toBe("60");

    const { token } = await app.createLink({ path: "single.txt", password: linkPassword });
    const ip = "198.51.100.41";
    expectProblem(await unlock(token, "wrong 1", ip), 401, problemTypes.shareLinkPasswordWrong);
    const locking = await unlock(token, "wrong 2", ip);
    expectProblem(locking, 429, problemTypes.tooManyAttempts);
    expect(locking.headers["retry-after"]).toBe(String(5 * 60));

    const big = join(app.resourceDir, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, bigSize);
    const open = await app.createLink({ path: "big.bin" });
    const held = await startDownload(open.token, ip);
    try {
      expect(held.statusCode).toBe(200);
      expectTooManyDownloads(await app.asPublic(routes.downloadShareLinkContent, open.token, { ip }));
    } finally {
      abort(held);
    }
  });
});
