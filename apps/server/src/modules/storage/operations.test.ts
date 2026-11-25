import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asRealPath, byteChunks, makeFifo, makeStorageRoot } from "../../test-support/index.ts";
import {
  freeSpace,
  list,
  makeFolder,
  moveIntoPlace,
  NameRefusedError,
  NameTakenError,
  openContained,
  PathRefusedError,
  remove,
  resolveInResource,
  stat,
  usedBytes,
  type ContainedPath,
  type NameConflict,
  type RealPath,
} from "./index.ts";

let temp: ReturnType<typeof makeStorageRoot>;
let root: RealPath;
let outside: string;

beforeEach(() => {
  temp = makeStorageRoot();
  root = asRealPath(join(temp.dir, "root"));
  outside = join(temp.dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside");
});

afterEach(() => {
  temp.cleanup();
});

const at = (relative: string): Promise<ContainedPath> => resolveInResource(root, relative);

describe("openContained", () => {
  it("reads and writes a file through the handle", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const path = await at("a.txt");
    const reader = await openContained(path, "read");
    try {
      expect((await reader.readFile()).toString()).toBe("hello");
    } finally {
      await reader.close();
    }
    const writer = await openContained(path, "write");
    try {
      await writer.write("J", 0);
    } finally {
      await writer.close();
    }
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("Jello");
  });

  it("refuses a folder, and a missing file", async () => {
    mkdirSync(join(root, "docs"));
    await expect(openContained(await at("docs"), "read")).rejects.toMatchObject({ reason: "not-a-file" });
    await expect(openContained(await at("docs"), "write")).rejects.toMatchObject({ reason: "not-a-file" });
    await expect(openContained(await at("gone.txt"), "read")).rejects.toMatchObject({ reason: "not-found" });
  });

  it("refuses a file swapped for a symlink after resolving", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    const path = await at("a.txt");
    symlinkSync(join(outside, "secret.txt"), join(root, "b.txt"));
    renameSync(join(root, "b.txt"), join(root, "a.txt"));
    await expect(openContained(path, "read")).rejects.toMatchObject({ reason: "symlink" });
  });
});

describe("list and stat", () => {
  it("lists entries by name, showing links and special files without following them", async () => {
    mkdirSync(join(root, "b-folder"));
    writeFileSync(join(root, "c.txt"), "12345");
    symlinkSync(outside, join(root, "a-link"));
    makeFifo(join(root, "d-pipe"));
    writeFileSync(join(root, ".nu-upload-0196"), "half");
    const entries = await list(await at(""));
    expect(entries.map(({ name, kind, size }) => ({ name, kind, size }))).toEqual([
      { name: "a-link", kind: "link", size: 0 },
      { name: "b-folder", kind: "folder", size: 0 },
      { name: "c.txt", kind: "file", size: 5 },
      { name: "d-pipe", kind: "other", size: 0 },
    ]);
    expect(entries[2]?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("refuses to list a file", async () => {
    writeFileSync(join(root, "c.txt"), "x");
    await expect(list(await at("c.txt"))).rejects.toMatchObject({ reason: "not-a-folder" });
  });

  it("stats a file, a folder and the root", async () => {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "c.txt"), "abc");
    expect(await stat(await at("docs/c.txt"))).toMatchObject({ name: "c.txt", kind: "file", size: 3 });
    expect(await stat(await at("docs"))).toMatchObject({ name: "docs", kind: "folder", size: 0 });
    expect(await stat(await at(""))).toMatchObject({ name: "", kind: "folder" });
    await expect(stat(await at("docs/none"))).rejects.toMatchObject({ reason: "not-found" });
  });

  it("answers free space", async () => {
    const space = await freeSpace(await at(""));
    expect(space.totalBytes).toBeGreaterThan(0);
    expect(space.availableBytes).toBeGreaterThanOrEqual(0);
    expect(space.availableBytes).toBeLessThanOrEqual(space.totalBytes);
  });
});

describe("usedBytes", () => {
  it("adds up the files below a folder without following symlinks", async () => {
    mkdirSync(join(root, "docs", "deep"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "12345");
    writeFileSync(join(root, "docs", "b.txt"), "123");
    writeFileSync(join(root, "docs", "deep", "c.txt"), "12");
    writeFileSync(join(outside, "big.bin"), "x".repeat(1000));
    symlinkSync(outside, join(root, "docs", "outside-link"));
    symlinkSync(join(outside, "big.bin"), join(root, "big-link"));
    makeFifo(join(root, "pipe"));
    expect(await usedBytes(await at(""))).toBe(10);
    expect(await usedBytes(await at("docs"))).toBe(5);
  });

  it("refuses a file and a forged path", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    await expect(usedBytes(await at("a.txt"))).rejects.toMatchObject({ reason: "not-a-folder" });
    const forged = { ...(await at("")) };
    await expect(usedBytes(forged)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("makeFolder", () => {
  it("makes a folder, and is idempotent", async () => {
    const first = await makeFolder(await at(""), "Photos");
    expect(first).toMatchObject({ relative: "Photos", absolute: join(root, "Photos") });
    expect(lstatSync(join(root, "Photos")).isDirectory()).toBe(true);
    const nested = await makeFolder(first, "Café");
    expect(nested.relative).toBe("Photos/Café");
    expect((await makeFolder(await at(""), "Photos")).absolute).toBe(first.absolute);
  });

  it("refuses an existing folder when the folder must be new", async () => {
    mkdirSync(join(root, "Photos"));
    await expect(makeFolder(await at(""), "Photos", { mustBeNew: true })).rejects.toBeInstanceOf(NameTakenError);
    expect((await makeFolder(await at(""), "Fresh", { mustBeNew: true })).relative).toBe("Fresh");
  });

  it("refuses an existing symlink or file with the name", async () => {
    symlinkSync(outside, join(root, "link"));
    writeFileSync(join(root, "file"), "x");
    await expect(makeFolder(await at(""), "link")).rejects.toMatchObject({ reason: "symlink" });
    await expect(makeFolder(await at(""), "file")).rejects.toMatchObject({ reason: "not-a-folder" });
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("refuses a bad name", async () => {
    await expect(makeFolder(await at(""), "..")).rejects.toBeInstanceOf(NameRefusedError);
    await expect(makeFolder(await at(""), "a/b")).rejects.toMatchObject({ reason: "slash" });
    await expect(makeFolder(await at(""), "CON")).rejects.toMatchObject({ reason: "reserved-name" });
  });
});

describe("remove", () => {
  it("removes a tree without following the symlinks in it", async () => {
    mkdirSync(join(root, "tree", "sub", "deeper"), { recursive: true });
    writeFileSync(join(root, "tree", "file.txt"), "x");
    writeFileSync(join(root, "tree", "sub", "deeper", "file.txt"), "x");
    symlinkSync(outside, join(root, "tree", "outside-link"));
    symlinkSync(outside, join(root, "tree", "sub", "deeper", "outside-link"));
    symlinkSync(join(outside, "secret.txt"), join(root, "tree", "sub", "secret-link"));
    makeFifo(join(root, "tree", "sub", "pipe"));
    await remove(await at("tree"));
    expect(existsSync(join(root, "tree"))).toBe(false);
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
  });

  it("removes a file, and a symlink but not its target", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    await remove(await at("a.txt"));
    expect(existsSync(join(root, "a.txt"))).toBe(false);

    const path = await at("later");
    symlinkSync(outside, join(root, "later"));
    await remove(path);
    expect(existsSync(join(root, "later"))).toBe(false);
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("refuses the root itself, and a missing entry", async () => {
    await expect(remove(await at(""))).rejects.toMatchObject({ reason: "invalid" });
    await expect(remove(await at("gone"))).rejects.toMatchObject({ reason: "not-found" });
    expect(existsSync(root)).toBe(true);
  });
});

async function upload(
  name: string,
  onConflict: NameConflict,
  text: string,
  uploadId = "0196a1b2-0000-7000-8000-000000000001",
): Promise<ContainedPath> {
  return moveIntoPlace({ folder: await at("docs"), name, uploadId, content: byteChunks(text.slice(0, 2), text.slice(2)), onConflict });
}

function files(): string[] {
  return readdirSync(join(root, "docs")).toSorted();
}

async function* failing(): AsyncGenerator<Uint8Array> {
  yield Buffer.from("part");
  throw new Error("client went away");
}

describe("moveIntoPlace", () => {
  beforeEach(() => {
    mkdirSync(join(root, "docs"));
  });

  it("writes the file under its name and leaves no temp file", async () => {
    const path = await upload("report.pdf", "refuse", "%PDF-1.7");
    expect(path).toMatchObject({ relative: "docs/report.pdf", absolute: join(root, "docs", "report.pdf") });
    expect(readFileSync(path.absolute, "utf8")).toBe("%PDF-1.7");
    expect(files()).toEqual(["report.pdf"]);
    expect(lstatSync(path.absolute).mode & 0o137).toBe(0);
  });

  it("refuses a taken name with refuse, keeping the existing file", async () => {
    writeFileSync(join(root, "docs", "report.pdf"), "old");
    await expect(upload("report.pdf", "refuse", "new")).rejects.toBeInstanceOf(NameTakenError);
    expect(readFileSync(join(root, "docs", "report.pdf"), "utf8")).toBe("old");
    expect(files()).toEqual(["report.pdf"]);
  });

  it("replaces a file with replace", async () => {
    writeFileSync(join(root, "docs", "report.pdf"), "old");
    const path = await upload("report.pdf", "replace", "new");
    expect(readFileSync(path.absolute, "utf8")).toBe("new");
    expect(files()).toEqual(["report.pdf"]);
  });

  it("never replaces a folder or a symlink", async () => {
    mkdirSync(join(root, "docs", "folder"));
    symlinkSync(join(outside, "secret.txt"), join(root, "docs", "link"));
    await expect(upload("folder", "replace", "new")).rejects.toBeInstanceOf(NameTakenError);
    await expect(upload("link", "replace", "new")).rejects.toBeInstanceOf(NameTakenError);
    await expect(upload("link", "refuse", "new")).rejects.toBeInstanceOf(NameTakenError);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
    expect(files()).toEqual(["folder", "link"]);
  });

  it("takes name (n).ext with keep-both", async () => {
    writeFileSync(join(root, "docs", "report.pdf"), "first");
    expect((await upload("report.pdf", "keep-both", "second")).relative).toBe("docs/report (1).pdf");
    expect((await upload("report.pdf", "keep-both", "third")).relative).toBe("docs/report (2).pdf");
    writeFileSync(join(root, "docs", ".bashrc"), "x");
    expect((await upload(".bashrc", "keep-both", "y")).relative).toBe("docs/.bashrc (1)");
    expect((await upload("archive.tar.gz", "keep-both", "z")).relative).toBe("docs/archive.tar.gz");
    expect(files()).toEqual([".bashrc", ".bashrc (1)", "archive.tar.gz", "report (1).pdf", "report (2).pdf", "report.pdf"]);
    expect(readFileSync(join(root, "docs", "report (2).pdf"), "utf8")).toBe("third");
    expect(readFileSync(join(root, "docs", "report.pdf"), "utf8")).toBe("first");
  });

  it("replaces a stale temp file of the same upload", async () => {
    writeFileSync(join(root, "docs", ".nu-upload-u1"), "stale");
    const path = await upload("a.txt", "refuse", "fresh", "u1");
    expect(readFileSync(path.absolute, "utf8")).toBe("fresh");
    expect(files()).toEqual(["a.txt"]);
  });

  it("removes the temp file when the content fails", async () => {
    await expect(
      moveIntoPlace({ folder: await at("docs"), name: "a.txt", uploadId: "u2", content: failing(), onConflict: "refuse" }),
    ).rejects.toThrow("client went away");
    expect(files()).toEqual([]);
  });

  it("refuses a bad name or upload id before writing anything", async () => {
    await expect(upload("con.txt", "refuse", "x")).rejects.toBeInstanceOf(NameRefusedError);
    await expect(upload("a.txt", "refuse", "x", "../../etc")).rejects.toBeInstanceOf(PathRefusedError);
    await expect(upload("a.txt", "refuse", "x", "")).rejects.toMatchObject({ reason: "invalid" });
    expect(files()).toEqual([]);
  });
});
