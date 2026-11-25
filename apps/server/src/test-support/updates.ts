import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateStatusFile } from "@not-unreachable/contracts";
import { signingKeyId } from "@not-unreachable/mount-helper/release-verify";
import { z } from "zod";
import {
  LATEST_RELEASE_URL,
  UPDATE_REQUEST_FILE,
  type UpdateHelper,
  type UpdateHelperOutcome,
  type UpdatesFetch,
} from "../modules/updates/index.ts";

/** The asset names of a release as the release workflow publishes it. */
export function defaultAssets(version: string): string[] {
  return [
    `not-unreachable-${version}-linux-x64.tar.gz`,
    `not-unreachable-${version}-linux-arm64.tar.gz`,
    "SHA256SUMS",
    "SHA256SUMS.sig",
    "install.sh",
  ];
}

/** GitHub's answer for a release, with the fields the server reads and a few it ignores. */
export function githubRelease(version = "1.5.0", assets: readonly string[] = defaultAssets(version)): Record<string, unknown> {
  return {
    id: 1,
    tag_name: `v${version}`,
    name: `NotUnreachable ${version}`,
    html_url: `https://github.com/przemczan/not-unreachable/releases/tag/v${version}`,
    published_at: "2026-11-25T12:00:00Z",
    draft: false,
    prerelease: false,
    body: "Release notes",
    assets: assets.map((name, index) => ({ id: index, name, browser_download_url: `https://evil.example/${name}` })),
  };
}

/** A release's three files, signed with a key pinned in `keysDir` (written there). */
export interface SignedRelease {
  readonly version: string;
  readonly keyId: string;
  /** By file name: the x64 tarball, `SHA256SUMS` and `SHA256SUMS.sig`. */
  readonly files: Map<string, Buffer>;
}

/** Signs a release of `version` for x64 with a new key, which it pins in `keysDir`. */
export function signedRelease(version: string, keysDir: string): SignedRelease {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = signingKeyId(publicKey);
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${keyId}.pem`), publicKey.export({ format: "pem", type: "spki" }));
  const tarball = Buffer.from(`not really a tarball of ${version}\n`);
  const tarballName = `not-unreachable-${version}-linux-x64.tar.gz`;
  const checksums = Buffer.from(`${createHash("sha256").update(tarball).digest("hex")}  ${tarballName}\n`);
  const signature = Buffer.from(`ed25519 ${keyId} ${sign(null, checksums, privateKey).toString("base64")}\n`);
  return {
    version,
    keyId,
    files: new Map([
      [tarballName, tarball],
      ["SHA256SUMS", checksums],
      ["SHA256SUMS.sig", signature],
    ]),
  };
}

export interface FakeGitHubReleases {
  readonly fetch: UpdatesFetch;
  /** Every request, in order. */
  readonly requests: { readonly url: string; readonly headers: Readonly<Record<string, string>> }[];
  /** What the release check answers; a function to fail. */
  latest: Record<string, unknown> | (() => Response);
  /** The release files by name, served from GitHub's download host after a redirect. */
  files: Map<string, Buffer>;
}

/** GitHub as the server sees it: the API's latest release, and downloads redirected to the assets host. */
export function fakeGitHubReleases(release: SignedRelease | undefined, version = release?.version ?? "1.5.0"): FakeGitHubReleases {
  const fake: FakeGitHubReleases = {
    requests: [],
    latest: githubRelease(version),
    files: release?.files ?? new Map(),
    fetch: async (url, { headers }) => {
      fake.requests.push({ url, headers });
      if (url === LATEST_RELEASE_URL) {
        return typeof fake.latest === "function" ? fake.latest() : Response.json(fake.latest);
      }
      const download = /^https:\/\/github\.com\/przemczan\/not-unreachable\/releases\/download\/v[^/]+\/(.+)$/.exec(url);
      if (download?.[1] !== undefined) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://release-assets.githubusercontent.com/${download[1]}?sig=x` },
        });
      }
      const asset = /^https:\/\/release-assets\.githubusercontent\.com\/([^?]+)/.exec(url)?.[1];
      const content = asset === undefined ? undefined : fake.files.get(asset);
      return content === undefined ? new Response("Not Found", { status: 404 }) : new Response(content, { status: 200 });
    },
  };
  return fake;
}

/** What the update helper found when it ran: the request file and the spool. */
export interface UpdateHelperRun {
  readonly request: string;
  readonly fileMode: number;
  readonly dirMode: number;
  readonly spool: Map<string, Buffer>;
}

export interface FakeUpdateHelper extends UpdateHelper {
  outcome: UpdateHelperOutcome;
  /** Written to the status file when the helper runs, if set (the request id filled in). */
  status: ((requestId: string) => UpdateStatusFile) | undefined;
  /** What `isRunning` answers: a verify unit that a stopped server started, still running. */
  running: boolean;
  readonly runs: UpdateHelperRun[];
}

/** A helper that needs no root: it keeps what it found, writes `status` if set, and answers `outcome`. */
export function fakeUpdateHelper(paths: {
  readonly requestsDir: string;
  readonly spoolDir: string;
  readonly statusFile: string;
}): FakeUpdateHelper {
  const fake: FakeUpdateHelper = {
    outcome: { ok: true },
    status: undefined,
    running: false,
    runs: [],
    async verify() {
      const file = join(paths.requestsDir, UPDATE_REQUEST_FILE);
      const request = readFileSync(file, "utf8");
      const spool = new Map<string, Buffer>();
      for (const name of ["SHA256SUMS", "SHA256SUMS.sig"]) spool.set(name, readFileSync(join(paths.spoolDir, name)));
      fake.runs.push({ request, fileMode: statSync(file).mode & 0o777, dirMode: statSync(paths.requestsDir).mode & 0o777, spool });
      if (fake.status !== undefined) {
        const { requestId } = z.object({ requestId: z.string() }).parse(JSON.parse(request));
        writeFileSync(paths.statusFile, JSON.stringify(fake.status(requestId)));
      }
      return fake.outcome;
    },
    async isRunning() {
      return fake.running;
    },
  };
  return fake;
}
