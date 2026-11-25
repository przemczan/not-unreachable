import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { TUS_VERSION, UPLOAD_CHUNK_MEDIA_TYPE, type RouteContract } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import type { AccountRecord } from "../modules/accounts/index.ts";
import type { FreeSpace } from "../modules/storage/index.ts";
import { buildTestApp, sameOriginWrite, viaProxy, type TestApp } from "./app.ts";
import { setTestHomeRoot } from "./invitations.ts";
import { concretePath } from "./sessions.ts";
import { makeStorageRoot } from "./storage.ts";

/** Plenty of free space, so only a test that lowers it meets the disk reserve. */
export const plentyOfSpace: FreeSpace = { availableBytes: 10 * 1024 ** 4, totalBytes: 20 * 1024 ** 4 };

export interface FilesTestApp {
  readonly test: TestApp;
  /** The admin's resource "Files" and its folder. */
  readonly resourceId: string;
  readonly resourceDir: string;
  readonly admin: AccountRecord;
  readonly adminCookie: string;
  /** A user with a home. */
  readonly user: AccountRecord;
  readonly userCookie: string;
  readonly homeDir: string;
  readonly stagingDir: string;
  /** What the fake `statfs` answers; change it to meet the disk reserve. Set `hold` to make it wait. */
  readonly space: { staging: FreeSpace; target: FreeSpace; hold?: Promise<void> };
  /** Another user with a home, and their session. */
  addUser(username: string): Promise<{ readonly account: AccountRecord; readonly cookie: string; readonly homeDir: string }>;
  close(): Promise<void>;
}

/** The app with a resource, a home root, the admin and a user with a home, and faked free space. */
export async function buildFilesTestApp(): Promise<FilesTestApp> {
  const storage = makeStorageRoot();
  const dataDir = join(storage.dir, "data");
  const stagingDir = join(dataDir, "uploads");
  const resourceDir = join(storage.dir, "files");
  const homesDir = join(storage.dir, "homes");
  mkdirSync(resourceDir);
  mkdirSync(homesDir);
  const space: FilesTestApp["space"] = { staging: plentyOfSpace, target: plentyOfSpace };
  const test = await buildTestApp({
    resourceRoots: { dataDir },
    uploads: {
      stagingDir,
      freeSpace: {
        staging: async () => {
          await space.hold;
          return space.staging;
        },
        target: async () => {
          await space.hold;
          return space.target;
        },
      },
    },
  });
  const resource = await test.services.resources.add({ kind: "local", name: "Files", localPath: resourceDir }, { kind: "system" });
  await setTestHomeRoot(test, homesDir);
  const admin = await test.createAdmin();
  const addUser = async (username: string) => {
    const account = test.createUser({ username });
    const homeDir = await test.services.resources.createHome(username);
    return { account, cookie: test.startSession(account), homeDir };
  };
  const user = await addUser("alice");
  return {
    test,
    resourceId: resource.id,
    resourceDir,
    admin,
    adminCookie: test.startSession(admin),
    user: user.account,
    userCookie: user.cookie,
    homeDir: user.homeDir,
    stagingDir,
    space,
    addUser,
    close: async () => {
      await test.close();
      storage.cleanup();
    },
  };
}

export interface FilesCallOptions {
  readonly cookie?: string;
  readonly params?: string;
  readonly query?: Record<string, string>;
  readonly payload?: object | string | Buffer | Readable;
  readonly headers?: Record<string, string>;
}

/** Calls a route as the SPA would, with any extra headers. */
export function callFilesRoute(
  test: Pick<TestApp, "app">,
  route: Pick<RouteContract, "method" | "path">,
  options: FilesCallOptions = {},
): Promise<LightMyRequestResponse> {
  const safe = route.method === "GET" || route.method === "HEAD";
  const query = options.query === undefined ? "" : `?${new URLSearchParams(options.query).toString()}`;
  return test.app.inject({
    method: route.method,
    url: `${concretePath(route, options.params)}${query}`,
    headers: {
      ...(safe ? viaProxy : sameOriginWrite),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** `Upload-Metadata` as tus-js-client sends it: each value base64, an empty one as the key and a space. */
export function encodeUploadMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(value, "utf8").toString("base64")}`)
    .join(",");
}

/** A tus client over `inject`, as one account. */
export interface TusTestClient {
  /** POST: answers the response; `location` is its `Location`. */
  create(length: number | null, metadata: Record<string, string>, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  head(location: string): Promise<LightMyRequestResponse>;
  patch(location: string, offset: number, body: Buffer | Readable, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  cancel(location: string): Promise<LightMyRequestResponse>;
  /** Creates and sends the whole content in one chunk; answers the last response. */
  upload(content: Buffer, metadata: Record<string, string>): Promise<LightMyRequestResponse>;
}

export function tusClient(test: Pick<TestApp, "app">, cookie: string): TusTestClient {
  const tus = { "tus-resumable": TUS_VERSION };
  const create: TusTestClient["create"] = (length, metadata, headers = {}) =>
    test.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: {
        ...sameOriginWrite,
        ...tus,
        cookie,
        ...(length === null ? {} : { "upload-length": String(length) }),
        "upload-metadata": encodeUploadMetadata(metadata),
        ...headers,
      },
    });
  const patch: TusTestClient["patch"] = (location, offset, body, headers = {}) =>
    test.app.inject({
      method: "PATCH",
      url: location,
      headers: { ...sameOriginWrite, ...tus, cookie, "content-type": UPLOAD_CHUNK_MEDIA_TYPE, "upload-offset": String(offset), ...headers },
      payload: body,
    });
  return {
    create,
    head: (location) => test.app.inject({ method: "HEAD", url: location, headers: { ...viaProxy, ...tus, cookie } }),
    patch,
    cancel: (location) => test.app.inject({ method: "DELETE", url: location, headers: { ...sameOriginWrite, ...tus, cookie } }),
    upload: async (content, metadata) => {
      const created = await create(content.byteLength, metadata);
      if (created.statusCode !== 201 || content.byteLength === 0) return created;
      return patch(locationOf(created), 0, content);
    },
  };
}

/** The `Location` of a tus creation; throws when there is none. */
export function locationOf(response: LightMyRequestResponse): string {
  const location = response.headers.location;
  if (typeof location !== "string") throw new Error(`No Location (status ${response.statusCode}): ${response.body}`);
  return location;
}

/** The upload id at the end of a `Location`. */
export function uploadIdOf(location: string): string {
  return location.slice(location.lastIndexOf("/") + 1);
}
