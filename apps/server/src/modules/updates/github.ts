import { createHash } from "node:crypto";
import { releaseVersionSchema, type UpdateReason } from "@not-unreachable/contracts";
import { z } from "zod";
import { MINUTE_MS } from "../platform/index.ts";

/**
 * The server's only requests to GitHub (deployment.md, "Updating from Settings"; threat model,
 * T17): the release check and the download of one release's files. Nothing in them identifies the
 * instance: fixed URLs and headers, no query, cookie, token or version.
 */

export const REPOSITORY = "przemczan/not-unreachable";
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases/`;
/** The release check's exact headers; a test checks nothing else is set. */
export const CHECK_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "not-unreachable",
};
const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = { Accept: "application/octet-stream", "User-Agent": "not-unreachable" };
export const CHECK_TIMEOUT_MS = 10_000;
export const MAX_CHECK_BODY_BYTES = 1024 * 1024;
/** A release download goes nowhere else, whatever a redirect says. */
export const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
export const MAX_REDIRECTS = 5;
/** Per file; 256 MiB over a slow line takes a while. */
export const DOWNLOAD_TIMEOUT_MS = 15 * MINUTE_MS;
const MAX_ASSETS = 100;

/** How the module reaches GitHub: `globalThis.fetch` in production, a fake in tests. */
export type UpdatesFetch = (
  url: string,
  init: {
    readonly method: "GET";
    readonly headers: Readonly<Record<string, string>>;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

export const systemUpdatesFetch: UpdatesFetch = (url, { method, headers, redirect, signal }) =>
  globalThis.fetch(url, { method, headers: { ...headers }, redirect, signal });

/** Why a download ended early: one of the server's own update reasons. */
export class DownloadError extends Error {
  override readonly name = "DownloadError";
  readonly reason: Extract<UpdateReason, "download-failed" | "download-incomplete">;

  constructor(reason: DownloadError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The latest release as GitHub described it, validated: what the database keeps. */
export const keptReleaseSchema = z.strictObject({
  version: releaseVersionSchema,
  publishedAt: z.iso.datetime(),
  releaseNotesUrl: z.string(),
  assets: z.array(z.string()).max(MAX_ASSETS),
});

export type KeptRelease = z.infer<typeof keptReleaseSchema>;

const assetNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

const releaseNotesUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value.startsWith(RELEASES_PAGE)) return false;
    // Normalised as written, so a `..` or an escaped character can't lead elsewhere on github.com.
    try {
      return new URL(value).href === value;
    } catch {
      return false;
    }
  }, "must be a page under the repository's releases");

/** The fields of GitHub's answer the server reads; anything else in it is ignored. */
const githubReleaseSchema = z.looseObject({
  tag_name: z
    .string()
    .regex(/^v/)
    .transform((tag) => tag.slice(1))
    .pipe(releaseVersionSchema),
  html_url: releaseNotesUrlSchema,
  published_at: z.iso.datetime({ offset: false }).transform((value) => new Date(value).toISOString()),
  assets: z.array(z.looseObject({ name: assetNameSchema })).max(MAX_ASSETS),
});

/** Parses GitHub's answer; throws on anything that isn't a release of the right shape. */
export function parseLatestRelease(body: unknown): KeptRelease {
  const release = githubReleaseSchema.parse(body);
  return {
    version: release.tag_name,
    publishedAt: release.published_at,
    releaseNotesUrl: release.html_url,
    assets: release.assets.map((asset) => asset.name),
  };
}

/** Reads a body up to `cap` bytes, hashing it on the way; past the cap, `download-incomplete`. */
async function* capped(body: ReadableStream<Uint8Array>, cap: number, hash: ReturnType<typeof createHash>): AsyncGenerator<Uint8Array> {
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > cap) throw new DownloadError("download-incomplete", `the file is larger than ${cap} bytes`);
      hash.update(chunk);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError("download-failed", "the download broke off");
  }
}

/** A body of at most `cap` bytes, as chunks, and its SHA-256 once read through. */
export interface CappedBody {
  readonly chunks: AsyncIterable<Uint8Array>;
  /** Lower-case hex; only once `chunks` was read to its end. */
  digest(): string;
}

function cappedBody(response: Response, cap: number): CappedBody {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    void response.body?.cancel().catch(() => undefined);
    throw new DownloadError("download-incomplete", `the file is larger than ${cap} bytes`);
  }
  if (response.body === null) throw new DownloadError("download-failed", "the answer has no body");
  const hash = createHash("sha256");
  return { chunks: capped(response.body, cap, hash), digest: () => hash.digest("hex") };
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

/** Asks GitHub for the latest release: one fixed GET, no redirect followed, 10 s, at most 1 MiB. */
export async function fetchLatestRelease(fetch: UpdatesFetch): Promise<KeptRelease> {
  const response = await fetch(LATEST_RELEASE_URL, {
    method: "GET",
    headers: CHECK_HEADERS,
    redirect: "manual",
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`GitHub answered ${response.status}`);
  }
  const body = await collect(cappedBody(response, MAX_CHECK_BODY_BYTES).chunks);
  return parseLatestRelease(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
}

/** Where a release file is downloaded from: never a URL from the API's answer. */
export function downloadUrl(version: string, file: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${file}`;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The next hop of a redirect, or `download-failed` when it leaves the allowed hosts or https. */
function redirectTarget(from: string, location: string | null): string {
  if (location === null) throw new DownloadError("download-failed", "a redirect without a Location");
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw new DownloadError("download-failed", "a redirect to an invalid URL");
  }
  if (
    target.protocol !== "https:" ||
    !DOWNLOAD_HOSTS.has(target.hostname) ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== ""
  ) {
    throw new DownloadError("download-failed", "a redirect off the allowed hosts");
  }
  return target.href;
}

/**
 * Downloads one release file: from {@link downloadUrl}, https only, redirects only to
 * {@link DOWNLOAD_HOSTS} and at most {@link MAX_REDIRECTS}; at most `cap` bytes.
 */
export async function openDownload(fetch: UpdatesFetch, version: string, file: string, cap: number): Promise<CappedBody> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let url = downloadUrl(version, file);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers: DOWNLOAD_HEADERS, redirect: "manual", signal });
    } catch {
      throw new DownloadError("download-failed", "GitHub couldn't be reached");
    }
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new DownloadError("download-failed", "too many redirects");
      url = redirectTarget(url, response.headers.get("location"));
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new DownloadError("download-failed", `GitHub answered ${response.status}`);
    }
    return cappedBody(response, cap);
  }
}
