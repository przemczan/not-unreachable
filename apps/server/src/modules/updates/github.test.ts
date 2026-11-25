import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { defaultAssets, githubRelease } from "../../test-support/index.ts";
import { DownloadError, fetchLatestRelease, openDownload, parseLatestRelease, type UpdatesFetch } from "./github.ts";
import { CHECK_TIMEOUT_MS, DOWNLOAD_HOSTS, LATEST_RELEASE_URL, MAX_CHECK_BODY_BYTES, MAX_REDIRECTS } from "./index.ts";

interface Request {
  readonly url: string;
  readonly init: Parameters<UpdatesFetch>[1];
}

function recordingFetch(answer: (url: string) => Response | Promise<Response>): {
  readonly fetch: UpdatesFetch;
  readonly requests: Request[];
} {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return answer(url);
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the release check's answer", () => {
  it("keeps the version, the release's page, its time and its asset names", () => {
    expect(parseLatestRelease(githubRelease())).toEqual({
      version: "1.5.0",
      publishedAt: "2026-11-25T12:00:00.000Z",
      releaseNotesUrl: "https://github.com/przemczan/not-unreachable/releases/tag/v1.5.0",
      assets: defaultAssets("1.5.0"),
    });
  });

  it.each([
    ["a tag without its v", { tag_name: "1.5.0" }],
    ["a tag that isn't a version", { tag_name: "v1.5" }],
    ["a tag with a path in it", { tag_name: "v1.5.0/../../x" }],
    ["a release page elsewhere", { html_url: "https://evil.example/przemczan/not-unreachable/releases/tag/v1.5.0" }],
    ["a release page of another repository", { html_url: "https://github.com/someone/not-unreachable/releases/tag/v1.5.0" }],
    ["a release page that climbs out", { html_url: "https://github.com/przemczan/not-unreachable/releases/../../../evil" }],
    ["a release page over http", { html_url: "http://github.com/przemczan/not-unreachable/releases/tag/v1.5.0" }],
    ["no publish time", { published_at: null }],
    ["a publish time that isn't one", { published_at: "yesterday" }],
    ["an asset name with a slash", { assets: [{ name: "../SHA256SUMS" }] }],
    ["an asset without a name", { assets: [{}] }],
    ["too many assets", { assets: Array.from({ length: 101 }, (_, index) => ({ name: `file-${index}` })) }],
  ])("refuses %s", (_case, change) => {
    expect(() => parseLatestRelease({ ...githubRelease(), ...change })).toThrow(ZodError);
  });
});

describe("asking GitHub for the latest release", () => {
  it("sends one fixed GET with the fixed headers only, follows no redirect and gives up after 10 s", async () => {
    const { fetch, requests } = recordingFetch(() => json(githubRelease()));
    expect((await fetchLatestRelease(fetch)).version).toBe("1.5.0");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://api.github.com/repos/przemczan/not-unreachable/releases/latest");
    expect(request?.url).toBe(LATEST_RELEASE_URL);
    expect(request?.init.method).toBe("GET");
    expect(request?.init.redirect).toBe("manual");
    // Nothing that tells which instance asks: no version, origin, cookie, token or query.
    expect(request?.init.headers).toEqual({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "not-unreachable",
    });
    expect(Object.keys(request?.init ?? {}).toSorted()).toEqual(["headers", "method", "redirect", "signal"]);
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
    expect(CHECK_TIMEOUT_MS).toBe(10_000);
  });

  it.each([
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.example/latest" } })],
    ["an HTTP error", () => json({ message: "Not Found" }, 404)],
    ["a body that isn't JSON", () => new Response("<html>", { status: 200 })],
    ["a malformed release", () => json({ tag_name: "v1.5.0" })],
    ["a body over 1 MiB", () => json({ ...githubRelease(), body: "x".repeat(MAX_CHECK_BODY_BYTES) })],
    [
      "a body over 1 MiB without a length",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_CHECK_BODY_BYTES));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    ],
  ])("fails on %s", async (_case, answer) => {
    const { fetch, requests } = recordingFetch(answer);
    await expect(fetchLatestRelease(fetch)).rejects.toThrow(Error);
    expect(requests).toHaveLength(1);
  });
});

async function read(body: Awaited<ReturnType<typeof openDownload>>): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const chunk of body.chunks) parts.push(chunk);
  return Buffer.concat(parts).toString();
}

async function reasonOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof DownloadError) return error.reason;
    throw error;
  }
  return "none";
}

const unreachable: UpdatesFetch = async () => {
  throw new TypeError("fetch failed");
};

describe("downloading a release file", () => {
  const file = "SHA256SUMS";
  const content = new TextEncoder().encode("the file\n");

  it("asks only the fixed release URL, and follows redirects to GitHub's download hosts", async () => {
    const { fetch, requests } = recordingFetch((url) => {
      if (url.startsWith("https://github.com/")) {
        return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/x?sig=1" } });
      }
      if (url.startsWith("https://release-assets.")) {
        return new Response(null, { status: 307, headers: { location: "https://objects.githubusercontent.com/y" } });
      }
      return new Response(content, { status: 200 });
    });
    const body = await openDownload(fetch, "1.5.0", file, 1024);
    expect(await read(body)).toBe("the file\n");
    expect(requests.map((request) => request.url)).toEqual([
      "https://github.com/przemczan/not-unreachable/releases/download/v1.5.0/SHA256SUMS",
      "https://release-assets.githubusercontent.com/x?sig=1",
      "https://objects.githubusercontent.com/y",
    ]);
    expect(requests.every((request) => request.init.redirect === "manual")).toBe(true);
    expect([...DOWNLOAD_HOSTS].toSorted()).toEqual(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
  });

  it("hashes what it reads", async () => {
    const { fetch } = recordingFetch(() => new Response(content, { status: 200 }));
    const body = await openDownload(fetch, "1.5.0", file, 1024);
    await read(body);
    expect(body.digest()).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it.each([
    ["another host", "https://evil.example/file"],
    ["a look-alike host", "https://github.com.evil.example/file"],
    ["http", "http://github.com/przemczan/not-unreachable/releases/download/v1.5.0/SHA256SUMS"],
    ["another port", "https://github.com:8443/file"],
    ["credentials", "https://user:pw@objects.githubusercontent.com/file"],
  ])("refuses a redirect to %s as download-failed", async (_case, location) => {
    const { fetch, requests } = recordingFetch(() => new Response(null, { status: 302, headers: { location } }));
    expect(await reasonOf(() => openDownload(fetch, "1.5.0", file, 1024))).toBe("download-failed");
    expect(requests).toHaveLength(1);
  });

  it(`follows at most ${MAX_REDIRECTS} redirects`, async () => {
    const { fetch, requests } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/again" } }),
    );
    expect(await reasonOf(() => openDownload(fetch, "1.5.0", file, 1024))).toBe("download-failed");
    expect(requests).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("answers download-failed when GitHub can't be reached or answers an error", async () => {
    expect(await reasonOf(() => openDownload(unreachable, "1.5.0", file, 1024))).toBe("download-failed");
    const { fetch } = recordingFetch(() => new Response("gone", { status: 404 }));
    expect(await reasonOf(() => openDownload(fetch, "1.5.0", file, 1024))).toBe("download-failed");
  });

  it("answers download-incomplete for a file over its cap, said up front or found while reading", async () => {
    const declared = recordingFetch(() => new Response(new Uint8Array(11), { status: 200, headers: { "content-length": "11" } }));
    expect(await reasonOf(() => openDownload(declared.fetch, "1.5.0", file, 10))).toBe("download-incomplete");

    const undeclared = recordingFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8));
              controller.enqueue(new Uint8Array(8));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    const body = await openDownload(undeclared.fetch, "1.5.0", file, 10);
    expect(await reasonOf(() => read(body))).toBe("download-incomplete");
  });

  it("answers download-failed when the body breaks off", async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4));
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200 },
        ),
    );
    const body = await openDownload(fetch, "1.5.0", file, 1024);
    expect(await reasonOf(() => read(body))).toBe("download-failed");
  });
});
