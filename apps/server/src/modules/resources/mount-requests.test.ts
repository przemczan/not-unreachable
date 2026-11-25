import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStorageRoot, writeMountInfo } from "../../test-support/index.ts";
import { deleteMountRequest, isCifsMount, parseMountInfo, writeMountRequest, type MountRequest } from "./index.ts";

const ID = "01900000-0000-7000-8000-0000000000ab";
const request: MountRequest = {
  host: "nas.local",
  share: "Photos",
  subfolder: "",
  username: "alice",
  password: "pw",
  domain: "",
  vers: "3.1.1",
  seal: true,
};

describe("the mount requests", () => {
  let storage: ReturnType<typeof makeStorageRoot>;
  let dir: string;

  beforeEach(() => {
    storage = makeStorageRoot();
    dir = join(storage.dir, "run", "mount-requests");
  });
  afterEach(() => {
    storage.cleanup();
  });

  it("writes the request 0600 in a 0700 folder it makes, replacing a stale one", async () => {
    await writeMountRequest(dir, ID, { ...request, password: "stale" });
    await writeMountRequest(dir, ID, request);
    const file = join(dir, `${ID}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(request);
    await deleteMountRequest(dir, ID);
    expect(existsSync(file)).toBe(false);
    // Nothing to delete is fine.
    await deleteMountRequest(dir, ID);
  });

  it("never writes through a symlink planted under the name", async () => {
    await writeMountRequest(dir, ID, request);
    const target = join(storage.dir, "target");
    writeFileSync(target, "keep");
    await deleteMountRequest(dir, ID);
    symlinkSync(target, join(dir, `${ID}.json`));
    await writeMountRequest(dir, ID, request);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("refuses an id that isn't a UUID", async () => {
    await expect(writeMountRequest(dir, "../../etc/passwd", request)).rejects.toThrow("A mount id must be a lower-case UUID");
  });

  it("parses mountinfo, with its octal escapes and optional fields", () => {
    const content = [
      "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
      String.raw`100 22 0:50 / /srv/my\040share\134x rw,nosuid shared:5 master:1 - cifs //nas/share rw`,
      "101 22 0:51 / /tmp rw - tmpfs tmpfs rw",
      "",
      "garbage",
    ].join("\n");
    expect(parseMountInfo(content)).toEqual([
      { mountPoint: "/", fsType: "ext4" },
      { mountPoint: String.raw`/srv/my share\x`, fsType: "cifs" },
      { mountPoint: "/tmp", fsType: "tmpfs" },
    ]);
  });

  it("answers whether a path is a cifs mount now", async () => {
    const file = join(storage.dir, "mountinfo");
    writeMountInfo(file, ["/srv/mounts/a b"]);
    expect(await isCifsMount("/srv/mounts/a b", file)).toBe(true);
    expect(await isCifsMount("/srv/mounts/a", file)).toBe(false);
    expect(await isCifsMount("/", file)).toBe(false);
    // Something mounted over the share hides it.
    writeFileSync(file, `${readFileSync(file, "utf8")}200 100 0:60 / /srv/mounts/a\\040b rw - tmpfs tmpfs rw\n`);
    expect(await isCifsMount("/srv/mounts/a b", file)).toBe(false);
  });
});
