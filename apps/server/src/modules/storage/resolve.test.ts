import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asRealPath, byteChunks, makeFifo, makeSocket, makeStorageRoot, tryMakeDevice } from "../../test-support/index.ts";
import {
  freeSpace,
  isContainedPath,
  list,
  makeFolder,
  moveIntoPlace,
  openContained,
  PathRefusedError,
  remove,
  resolveInResource,
  stat,
  type ContainedPath,
  type PathRefusal,
  type RealPath,
} from "./index.ts";

let temp: ReturnType<typeof makeStorageRoot>;
let root: RealPath;
let outside: string;

beforeEach(() => {
  temp = makeStorageRoot();
  root = asRealPath(join(temp.dir, "root"));
  outside = join(temp.dir, "outside");
  mkdirSync(join(root, "docs", "deep"), { recursive: true });
  writeFileSync(join(root, "docs", "a.txt"), "inside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside");
});

afterEach(() => {
  temp.cleanup();
});

async function refusal(promise: Promise<unknown>): Promise<PathRefusal> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof PathRefusedError)) throw new Error("Expected a PathRefusedError", { cause: error });
  return error.reason;
}

describe("resolveInResource: input rules (T5 step 1)", () => {
  it.each<[string, string, PathRefusal]>([
    ["../", "../", "invalid"],
    ["a/../../b", "a/../../b", "invalid"],
    ["a single dot", "docs/./a.txt", "invalid"],
    ["..\\ (backslash)", "..\\", "invalid"],
    ["a backslash inside a name", "docs\\a.txt", "invalid"],
    ["an absolute path", "/etc/passwd", "invalid"],
    ["a NUL byte", "docs/a.txt\0.png", "invalid"],
    ["a control character", "docs/a\u0001.txt", "invalid"],
    ["DEL", "docs/a\u007f.txt", "invalid"],
    ["a lone surrogate", "docs/\ud800.txt", "invalid"],
    ["a 256-byte segment", `docs/${"a".repeat(256)}`, "too-long"],
    ["a 128-character two-byte segment (256 bytes)", `docs/${"é".repeat(128)}`, "too-long"],
    ["over 4096 bytes", Array.from({ length: 20 }, () => "b".repeat(250)).join("/"), "too-long"],
  ])("refuses %s", async (_case, relative, reason) => {
    expect(await refusal(resolveInResource(root, relative))).toBe(reason);
  });

  it("accepts a 255-byte segment and exactly 4096 bytes", async () => {
    expect((await resolveInResource(root, `docs/${"a".repeat(255)}`)).relative).toBe(`docs/${"a".repeat(255)}`);
    const exactly = Array.from({ length: 17 }, () => "c".repeat(240)).join("/");
    expect(Buffer.byteLength(exactly)).toBe(4096);
    expect(await refusal(resolveInResource(root, exactly))).toBe("not-found");
    expect(await refusal(resolveInResource(root, `${exactly}c`))).toBe("too-long");
  });

  it("treats %2e%2e/ literally: a child named %2e%2e, still inside", async () => {
    mkdirSync(join(root, "%2e%2e"));
    const path = await resolveInResource(root, "%2e%2e/passwd");
    expect(path.relative).toBe("%2e%2e/passwd");
    expect(path.absolute).toBe(join(root, "%2e%2e", "passwd"));
    expect(path.absolute.startsWith(`${root}/`)).toBe(true);
  });

  it("collapses duplicate slashes and drops a trailing slash", async () => {
    const path = await resolveInResource(root, "docs//deep/");
    expect(path.relative).toBe("docs/deep");
    expect(path.absolute).toBe(join(root, "docs", "deep"));
  });

  it("answers the root itself for an empty path", async () => {
    const path = await resolveInResource(root, "");
    expect(path).toMatchObject({ root, relative: "", absolute: root });
    expect(Object.isFrozen(path)).toBe(true);
    expect(isContainedPath(path)).toBe(true);
  });

  it("normalises an NFD name to NFC", async () => {
    const nfc = "Café.txt";
    writeFileSync(join(root, nfc), "x");
    const path = await resolveInResource(root, "Café.txt");
    expect(path.relative).toBe(nfc);
    expect((await stat(path)).kind).toBe("file");
  });
});

describe("resolveInResource: the walk (T5 steps 2–4)", () => {
  it("allows a missing last segment but not a missing parent", async () => {
    expect((await resolveInResource(root, "docs/new.txt")).relative).toBe("docs/new.txt");
    expect(await refusal(resolveInResource(root, "nope/new.txt"))).toBe("not-found");
  });

  it("refuses a file used as a folder", async () => {
    expect(await refusal(resolveInResource(root, "docs/a.txt/x"))).toBe("not-a-folder");
  });

  it("refuses a symlink to /etc, as the last segment or on the way", async () => {
    symlinkSync("/etc", join(root, "etc"));
    expect(await refusal(resolveInResource(root, "etc"))).toBe("symlink");
    expect(await refusal(resolveInResource(root, "etc/passwd"))).toBe("symlink");
  });

  it("refuses a symlink to a sibling home", async () => {
    const homes = join(temp.dir, "homes");
    mkdirSync(join(homes, "alice"), { recursive: true });
    mkdirSync(join(homes, "bob"));
    writeFileSync(join(homes, "bob", "diary.txt"), "bob's");
    symlinkSync("../bob", join(homes, "alice", "bob-link"));
    const alice = asRealPath(join(homes, "alice"));
    expect(await refusal(resolveInResource(alice, "bob-link"))).toBe("symlink");
    expect(await refusal(resolveInResource(alice, "bob-link/diary.txt"))).toBe("symlink");
  });

  it("refuses a symlink pointing inside the root too", async () => {
    symlinkSync("docs", join(root, "docs-link"));
    expect(await refusal(resolveInResource(root, "docs-link/a.txt"))).toBe("symlink");
  });

  it("refuses a root that is a symlink, missing or not real", async () => {
    symlinkSync(root, join(temp.dir, "root-link"));
    expect(await refusal(resolveInResource(asRealPath(join(temp.dir, "root-link")), "docs"))).toBe("symlink");
    expect(await refusal(resolveInResource(asRealPath(join(temp.dir, "gone")), ""))).toBe("not-found");
    expect(await refusal(resolveInResource(asRealPath(join(root, "docs", "a.txt")), ""))).toBe("not-a-folder");
    expect(await refusal(resolveInResource(asRealPath(`${root}/docs/..`), ""))).toBe("outside-root");
    expect(await refusal(resolveInResource(asRealPath("relative"), ""))).toBe("invalid");
  });
});

describe("special files (T5 step 5)", () => {
  it("refuses a FIFO, in resolve and in open", async () => {
    makeFifo(join(root, "pipe"));
    expect(await refusal(resolveInResource(root, "pipe"))).toBe("special-file");

    const later = await resolveInResource(root, "later");
    makeFifo(join(root, "later"));
    expect(await refusal(openContained(later, "read"))).toBe("special-file");
    expect(await refusal(openContained(later, "write"))).toBe("special-file");
    expect(await refusal(stat(later))).toBe("special-file");
  });

  describe("a socket", () => {
    let server: Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) => {
        if (server === undefined) resolve();
        else server.close(() => resolve());
      });
      server = undefined;
    });

    it("is refused in resolve and in open", async () => {
      server = await makeSocket(join(root, "sock"));
      expect(await refusal(resolveInResource(root, "sock"))).toBe("special-file");
      const later = await resolveInResource(root, "docs/sock");
      server.close();
      server = await makeSocket(join(root, "docs", "sock"));
      expect(await refusal(openContained(later, "read"))).toBe("special-file");
    });
  });

  it("refuses a device", async (context) => {
    context.skip(!tryMakeDevice(join(root, "null")), "this runner can't make device files");
    expect(await refusal(resolveInResource(root, "null"))).toBe("special-file");
  });
});

function swapDocsForLinkOutside(): void {
  renameSync(join(root, "docs"), join(root, "docs-old"));
  writeFileSync(join(outside, "a.txt"), "outside");
  symlinkSync(outside, join(root, "docs"));
}

describe("a folder swapped for a symlink between resolve and open (T5 step 5)", () => {
  it("is caught by openContained", async () => {
    const path = await resolveInResource(root, "docs/a.txt");
    swapDocsForLinkOutside();
    expect(await refusal(openContained(path, "read"))).toBe("outside-root");
    expect(await refusal(openContained(path, "write"))).toBe("outside-root");
    expect(await refusal(stat(path))).toBe("outside-root");
  });

  it("is caught by list, makeFolder, moveIntoPlace and freeSpace on the folder itself", async () => {
    const folder = await resolveInResource(root, "docs");
    swapDocsForLinkOutside();
    expect(await refusal(list(folder))).toBe("symlink");
    expect(await refusal(makeFolder(folder, "x"))).toBe("symlink");
    expect(await refusal(freeSpace(folder))).toBe("symlink");
    expect(await refusal(moveIntoPlace({ folder, name: "x.txt", uploadId: "u1", content: byteChunks(), onConflict: "refuse" }))).toBe(
      "symlink",
    );
  });

  it("is caught by remove, which touches neither side", async () => {
    mkdirSync(join(root, "docs", "deep", "inner"));
    const parentSwapped = await resolveInResource(root, "docs/deep");
    const grandparentSwapped = await resolveInResource(root, "docs/deep/inner");
    swapDocsForLinkOutside();
    mkdirSync(join(outside, "deep", "inner"), { recursive: true });
    expect(await refusal(remove(parentSwapped))).toBe("symlink");
    expect(await refusal(remove(grandparentSwapped))).toBe("outside-root");
    expect(existsSync(join(outside, "deep", "inner"))).toBe(true);
    expect(existsSync(join(root, "docs-old", "deep", "inner"))).toBe(true);
  });
});

function forged(): ContainedPath {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the forgery under test.
  return { root, relative: "docs/a.txt", absolute: join(root, "docs", "a.txt") } as unknown as ContainedPath;
}

describe("a forged ContainedPath", () => {
  it("is not a ContainedPath", () => {
    expect(isContainedPath(forged())).toBe(false);
    expect(isContainedPath(null)).toBe(false);
    expect(isContainedPath("docs")).toBe(false);
  });

  it("can't be copied into a real one", async () => {
    const real = await resolveInResource(root, "docs/a.txt");
    expect(isContainedPath({ ...real })).toBe(false);
  });

  it.each<[string, (path: ContainedPath) => Promise<unknown>]>([
    ["openContained", (path) => openContained(path, "read")],
    ["list", (path) => list(path)],
    ["stat", (path) => stat(path)],
    ["makeFolder", (path) => makeFolder(path, "x")],
    ["remove", (path) => remove(path)],
    ["moveIntoPlace", (path) => moveIntoPlace({ folder: path, name: "x", uploadId: "u", content: byteChunks(), onConflict: "refuse" })],
    ["freeSpace", (path) => freeSpace(path)],
  ])("is refused by %s", async (_name, operation) => {
    await expect(operation(forged())).rejects.toThrow(TypeError);
  });
});
