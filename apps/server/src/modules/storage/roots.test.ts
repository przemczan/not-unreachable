import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStorageRoot } from "../../test-support/index.ts";
import { canonicalPath, fixRoot } from "./index.ts";

let temp: ReturnType<typeof makeStorageRoot>;

beforeEach(() => {
  temp = makeStorageRoot();
});

afterEach(() => {
  chmodSync(temp.dir, 0o700);
  temp.cleanup();
});

describe("fixRoot", () => {
  it("answers the real path of a writable folder and leaves no probe behind", async () => {
    mkdirSync(join(temp.dir, "photos"));
    symlinkSync(join(temp.dir, "photos"), join(temp.dir, "link"));
    expect(await fixRoot(join(temp.dir, "link"))).toEqual({ ok: true, realPath: join(temp.dir, "photos") });
    expect(await fixRoot(`${temp.dir}/photos/../photos/`)).toEqual({ ok: true, realPath: join(temp.dir, "photos") });
    expect(readdirSync(join(temp.dir, "photos"))).toEqual([]);
  });

  it("refuses a relative path", async () => {
    expect(await fixRoot("photos")).toEqual({ ok: false, reason: "not-absolute" });
  });

  it("refuses a missing folder", async () => {
    expect(await fixRoot(join(temp.dir, "gone"))).toEqual({ ok: false, reason: "missing" });
    symlinkSync(join(temp.dir, "gone"), join(temp.dir, "dangling"));
    expect(await fixRoot(join(temp.dir, "dangling"))).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a file", async () => {
    writeFileSync(join(temp.dir, "file"), "x");
    expect(await fixRoot(join(temp.dir, "file"))).toEqual({ ok: false, reason: "not-a-folder" });
    expect(await fixRoot(join(temp.dir, "file", "below"))).toEqual({ ok: false, reason: "not-a-folder" });
  });

  it.skipIf(process.getuid?.() === 0)("refuses a folder the service can't write to", async () => {
    const readOnly = join(temp.dir, "read-only");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      expect(await fixRoot(readOnly)).toEqual({ ok: false, reason: "not-writable" });
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });

  it.skipIf(process.getuid?.() === 0)("answers not-writable for a folder the service can't reach (ProtectHome=yes)", async () => {
    const hidden = join(temp.dir, "home");
    mkdirSync(join(hidden, "alice"), { recursive: true });
    chmodSync(hidden, 0o000);
    try {
      expect(await fixRoot(join(hidden, "alice"))).toEqual({ ok: false, reason: "not-writable" });
    } finally {
      chmodSync(hidden, 0o700);
    }
  });
});

describe("canonicalPath", () => {
  it("resolves symlinks in the existing part and keeps the missing rest", async () => {
    mkdirSync(join(temp.dir, "real"));
    symlinkSync(join(temp.dir, "real"), join(temp.dir, "link"));
    expect(await canonicalPath(join(temp.dir, "link", "not", "yet"))).toBe(join(temp.dir, "real", "not", "yet"));
    expect(await canonicalPath(`${temp.dir}/link/./a/../b/`)).toBe(join(temp.dir, "real", "b"));
    expect(await canonicalPath(join(temp.dir, "link"))).toBe(join(temp.dir, "real"));
  });

  it.skipIf(process.getuid?.() === 0)("stops at the deepest ancestor it can reach", async () => {
    const hidden = join(temp.dir, "home");
    mkdirSync(join(hidden, "alice"), { recursive: true });
    chmodSync(hidden, 0o000);
    try {
      expect(await canonicalPath(join(hidden, "alice", "files"))).toBe(join(hidden, "alice", "files"));
    } finally {
      chmodSync(hidden, 0o700);
    }
  });

  it("makes a relative path absolute", async () => {
    expect(await canonicalPath("relative/below")).toBe(join(await canonicalPath(process.cwd()), "relative", "below"));
  });
});
