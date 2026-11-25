/*
 * The SMB integration test (smb.md, "Testing"): the real app, the real mount runner (systemctl),
 * polkit, the root mount helper and a Samba server that requires SMB 3.1.1 with encryption.
 *
 * It runs only in CI (`pnpm test:smb`, job `smb` in .github/workflows/ci.yml), as the service user
 * `not-unreachable`, so polkit's rule and the helper's owner check are exercised for real. When
 * anything it needs is missing it fails, never skips: a skipped run would look like a passing one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { entriesPageSchema, resourceCheckSchema, routes, smbResourceSchema, type SmbProtocol } from "@not-unreachable/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, callFilesRoute, makeTempDir, tusClient, type TestApp } from "../test-support/index.ts";

const SERVICE_USER = "not-unreachable";
const MOUNT_ROOT = "/srv/not-unreachable/mounts";
const MOUNT_REQUESTS_DIR = "/run/not-unreachable/mount-requests";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set: the SMB integration test needs SMB_TEST_HOST, SMB_TEST_SHARE, SMB_TEST_USERNAME and SMB_TEST_PASSWORD`,
    );
  }
  return value;
}

/** Fails, with what is missing, unless the host is set up as the CI job sets it up. */
function checkPrerequisites(): void {
  const problems: string[] = [];
  if (userInfo().username !== SERVICE_USER) problems.push(`it must run as the user ${SERVICE_USER}, not ${userInfo().username}`);
  if (!existsSync(MOUNT_ROOT)) problems.push(`${MOUNT_ROOT} is missing`);
  if (!existsSync("/run/not-unreachable")) problems.push("/run/not-unreachable is missing");
  if (!existsSync("/usr/lib/not-unreachable/mount-helper.mjs")) problems.push("the mount helper is not installed");
  if (!existsSync("/etc/systemd/system/not-unreachable-mount@.service")) problems.push("the mount unit is not installed");
  if (problems.length > 0) throw new Error(`The SMB integration test can't run here: ${problems.join("; ")}`);
}

/** The `/proc/self/mountinfo` line of the mount at `mountPoint`, if there is one. */
function mountInfoAt(mountPoint: string): { readonly fsType: string; readonly options: string[] } | undefined {
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const [before, after] = line.split(" - ");
    if (before === undefined || after === undefined) continue;
    const fields = before.split(" ");
    if (fields[4] !== mountPoint) continue;
    const [fsType = "", , superOptions = ""] = after.split(" ");
    return { fsType, options: [...(fields[5] ?? "").split(","), ...superOptions.split(",")] };
  }
  return undefined;
}

/** The mount request files the app left (the helper deletes them; the app deletes unread ones). */
function leftoverMountRequests(): string[] {
  if (!existsSync(MOUNT_REQUESTS_DIR)) return [];
  return readdirSync(MOUNT_REQUESTS_DIR).filter((name) => name.endsWith(".json"));
}

describe("an SMB share, end to end", () => {
  const connection = {
    host: "",
    share: "",
    username: "",
    password: "",
    protocol: "3.1.1" satisfies SmbProtocol,
    encrypt: true,
  };
  let temp: ReturnType<typeof makeTempDir>;
  let test: TestApp;
  let cookie: string;
  let resourceId: string | undefined;
  let removed = false;
  const fileName = `nu-smb-test-${randomUUID()}.bin`;
  const content = randomBytes(256 * 1024 + 17);

  beforeAll(async () => {
    checkPrerequisites();
    connection.host = requiredEnv("SMB_TEST_HOST");
    connection.share = requiredEnv("SMB_TEST_SHARE");
    connection.username = requiredEnv("SMB_TEST_USERNAME");
    connection.password = requiredEnv("SMB_TEST_PASSWORD");
    temp = makeTempDir("nu-smb-test-");
    // The real mount runner and the default mount root and request folder.
    test = await buildTestApp({ resourceRoots: { dataDir: join(temp.dir, "data") } });
    cookie = await test.signIn((await test.createAdmin()).username);
  });

  afterAll(async () => {
    // Don't leave a mount behind when a step failed half-way.
    if (resourceId !== undefined && !removed) {
      await callFilesRoute(test, routes.removeResource, { cookie, params: resourceId });
    }
    await test?.close();
    temp?.cleanup();
  });

  it("refuses a wrong password, leaving no request file", async () => {
    const response = await callFilesRoute(test, routes.checkResource, {
      cookie,
      payload: { kind: "smb", ...connection, password: `${connection.password}-wrong` },
    });
    expect(response.statusCode).toBe(200);
    expect(resourceCheckSchema.parse(response.json())).toEqual({ outcome: "failed", reason: "auth" });
    expect(leftoverMountRequests()).toEqual([]);
  });

  it("connects with Test connection, leaving no request file", async () => {
    const response = await callFilesRoute(test, routes.checkResource, { cookie, payload: { kind: "smb", ...connection } });
    expect(response.statusCode).toBe(200);
    const check = resourceCheckSchema.parse(response.json());
    expect(check).toEqual({ outcome: "connected", folderCount: expect.any(Number) });
    expect(leftoverMountRequests()).toEqual([]);
  });

  it("adds the share over SMB 3.1.1 with encryption, and mounts it", async () => {
    const response = await callFilesRoute(test, routes.addResource, { cookie, payload: { kind: "smb", name: "Samba", ...connection } });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(connection.password);
    const resource = smbResourceSchema.parse(response.json());
    resourceId = resource.id;
    expect(resource).toMatchObject({ state: "available", protocol: "3.1.1", encrypt: true, smbPasswordSet: true });

    const mount = mountInfoAt(join(MOUNT_ROOT, resource.id));
    expect(mount?.fsType).toBe("cifs");
    expect(mount?.options).toContain("seal");
    expect(mount?.options).toContain("vers=3.1.1");
    expect(leftoverMountRequests()).toEqual([]);
  });

  it("uploads a file into the share", async () => {
    if (resourceId === undefined) throw new Error("The share was not added");
    const response = await tusClient(test, cookie).upload(content, { name: fileName, resourceId });
    expect(response.statusCode).toBe(204);
    const listed = await callFilesRoute(test, routes.listResourceEntries, { cookie, params: resourceId });
    expect(listed.statusCode).toBe(200);
    expect(entriesPageSchema.parse(listed.json()).entries).toContainEqual(
      expect.objectContaining({ name: fileName, kind: "file", size: content.byteLength }),
    );
  });

  it("downloads a byte range of it", async () => {
    if (resourceId === undefined) throw new Error("The share was not added");
    const start = 1000;
    const end = 200_000;
    const response = await callFilesRoute(test, routes.downloadResourceFile, {
      cookie,
      params: resourceId,
      query: { path: fileName },
      headers: { range: `bytes=${start}-${end}` },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes ${start}-${end}/${content.byteLength}`);
    expect(response.rawPayload.equals(content.subarray(start, end + 1))).toBe(true);
  });

  it("deletes it", async () => {
    if (resourceId === undefined) throw new Error("The share was not added");
    const response = await callFilesRoute(test, routes.deleteResourceEntry, { cookie, params: resourceId, query: { path: fileName } });
    expect(response.statusCode).toBe(204);
    const listed = await callFilesRoute(test, routes.listResourceEntries, { cookie, params: resourceId });
    expect(entriesPageSchema.parse(listed.json()).entries.map((entry) => entry.name)).not.toContain(fileName);
  });

  it("removes the share, unmounting it and removing its mount point", async () => {
    if (resourceId === undefined) throw new Error("The share was not added");
    const response = await callFilesRoute(test, routes.removeResource, { cookie, params: resourceId });
    expect(response.statusCode).toBe(204);
    removed = true;
    const mountPoint = join(MOUNT_ROOT, resourceId);
    expect(mountInfoAt(mountPoint)).toBeUndefined();
    expect(existsSync(mountPoint)).toBe(false);
    expect(leftoverMountRequests()).toEqual([]);
    // The helper's credentials files (/run/not-unreachable-mount/, root 0700) can't be read from
    // here; the CI job checks them as root after this test.
  });
});
