import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the reader is one file, not a module with an index.ts.
import { ArchiveError, checkReleaseArchive, MAX_ENTRIES, unpackReleaseArchive, type ArchiveProblem } from "../src/release-archive.mts";
import { releaseEntries, tar, tarGz, type TarEntry } from "./tar-builder.ts";

const TOP = "not-unreachable-1.5.0-linux-x64";

let root: string;
let tarball: string;
let target: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "release-archive-")));
  tarball = join(root, "release.tar.gz");
  target = join(root, "staged");
  await mkdir(target);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const good = (): TarEntry[] => releaseEntries(TOP, "1.5.0", "x64");

async function problemOf(work: Promise<unknown>): Promise<ArchiveProblem | "none"> {
  try {
    await work;
    return "none";
  } catch (error) {
    if (error instanceof ArchiveError) return error.problem;
    throw error;
  }
}

/** The problem pass 1 finds, after checking that pass 2 finds the same and writes nothing outside. */
async function refusal(archive: Buffer): Promise<ArchiveProblem | "none"> {
  await writeFile(tarball, archive);
  const first = await problemOf(checkReleaseArchive(tarball, TOP));
  const second = await problemOf(unpackReleaseArchive(tarball, TOP, target));
  expect(second).toBe(first);
  return first;
}

describe("a good release archive", () => {
  it("is checked, gives VERSION and ARCH, and unpacks as root's files with the archive's executable bits", async () => {
    await writeFile(tarball, tarGz(good()));
    expect(await checkReleaseArchive(tarball, TOP)).toEqual({ version: "1.5.0", arch: "x64" });
    await unpackReleaseArchive(tarball, TOP, target);
    const top = join(target, TOP);
    expect(await readFile(join(top, "VERSION"), "utf8")).toBe("1.5.0\n");
    expect((await stat(join(top, "install.sh"))).mode & 0o7777).toBe(0o755);
    expect((await stat(join(top, "VERSION"))).mode & 0o7777).toBe(0o644);
    expect((await stat(join(top, "release"))).mode & 0o7777).toBe(0o755);
    expect(await readlink(join(top, "release/node_modules/zod"))).toBe(".pnpm/zod@4.0.0/node_modules/zod");
    expect(await readFile(join(top, "release/node_modules/zod/index.js"), "utf8")).toBe("export {};\n");
  });

  it("makes folders an entry lies in before their own entry, and takes that entry afterwards", async () => {
    await writeFile(
      tarball,
      tarGz([
        { name: `${TOP}/a/b/file`, content: "x" },
        { name: `${TOP}/a/`, type: "directory", mode: 0o700 },
        { name: `${TOP}/VERSION`, content: "1.5.0\n" },
      ]),
    );
    expect(await checkReleaseArchive(tarball, TOP)).toEqual({ version: "1.5.0", arch: undefined });
    await unpackReleaseArchive(tarball, TOP, target);
    expect((await stat(join(target, TOP, "a"))).mode & 0o7777).toBe(0o755);
  });

  it("takes long names and link targets from pax records", async () => {
    const deep = `${TOP}/release/node_modules/.pnpm/${"x".repeat(120)}/index.js`;
    await writeFile(tarball, tarGz([...good(), { name: deep, content: "long\n" }]));
    await unpackReleaseArchive(tarball, TOP, target);
    expect(await readFile(join(target, deep), "utf8")).toBe("long\n");
  });

  it("refuses to unpack over anything already there, a symlink least of all", async () => {
    await writeFile(tarball, tarGz(good()));
    await mkdir(join(target, TOP));
    await symlink(join(root, "elsewhere"), join(target, TOP, "VERSION"));
    await expect(unpackReleaseArchive(tarball, TOP, target)).rejects.toThrow(/EEXIST/u);
    await expect(lstat(join(root, "elsewhere"))).rejects.toThrow(/ENOENT/u);
  });
});

// GNU tar is what build-tarball.sh runs; with --format=pax it writes only what the reader takes.
const gnuTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout.includes("GNU tar");

async function bundle(): Promise<string> {
  const source = join(root, "source");
  const top = join(source, TOP);
  const modules = join(top, "release", "node_modules");
  await mkdir(join(modules, ".pnpm", `${"long-package-name".repeat(8)}@1.0.0`, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(modules, ".pnpm", `${"long-package-name".repeat(8)}@1.0.0`, "node_modules", "pkg", "index.js"), "export {};\n");
  await symlink(`.pnpm/${"long-package-name".repeat(8)}@1.0.0/node_modules/pkg`, join(modules, "pkg"));
  await writeFile(join(top, "VERSION"), "1.5.0\n");
  await writeFile(join(top, "ARCH"), "x64\n");
  await writeFile(join(top, "install.sh"), "#!/usr/bin/env bash\n");
  await chmod(join(top, "install.sh"), 0o755);
  return source;
}

function gnu(source: string, format: string[]): void {
  const result = spawnSync(
    "tar",
    [
      "--create",
      "--gzip",
      ...format,
      "--file",
      tarball,
      "--directory",
      source,
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--sort=name",
      TOP,
    ],
    { encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
}

describe.skipIf(!gnuTar)("an archive GNU tar wrote", () => {
  it("is read with --format=pax", async () => {
    gnu(await bundle(), ["--format=pax"]);
    expect(await checkReleaseArchive(tarball, TOP)).toEqual({ version: "1.5.0", arch: "x64" });
    await unpackReleaseArchive(tarball, TOP, target);
    expect(await readFile(join(target, TOP, "release/node_modules/pkg/index.js"), "utf8")).toBe("export {};\n");
  });

  // GNU tar's own format names long paths with its 'L' entries, which the reader doesn't take.
  it("is refused in GNU tar's own format", async () => {
    gnu(await bundle(), ["--format=gnu"]);
    expect(await problemOf(checkReleaseArchive(tarball, TOP))).toBe("archive-invalid");
  });
});

describe("archive-unsafe", () => {
  it.each<[string, TarEntry[]]>([
    ["an entry outside the top folder", [{ name: "other/file", content: "x" }]],
    ["a second top folder", [{ name: "not-unreachable-1.5.1-linux-x64/VERSION", content: "1.5.1\n" }]],
    ["a file beside the top folder", [{ name: "README", content: "x" }]],
    ["the top folder as a file", [{ name: TOP, content: "x" }]],
    ["an absolute name", [{ name: `/${TOP}/VERSION`, content: "x" }]],
    ["a .. component", [{ name: `${TOP}/../escape`, content: "x" }]],
    ["a deep .. component", [{ name: `${TOP}/release/../../escape`, content: "x" }]],
    ["an empty component", [{ name: `${TOP}//file`, content: "x" }]],
    ["a . component", [{ name: `${TOP}/./file`, content: "x" }]],
    ["a file name ending in /", [{ name: `${TOP}/file/`, content: "x" }]],
    ["a NUL in a pax path", [{ name: `${TOP}/file`, content: "x", pax: { path: `${TOP}/fi\0le` } }]],
    ["a pax path climbing out", [{ name: `${TOP}/file`, content: "x", pax: { path: `${TOP}/../../etc/passwd` } }]],
    ["a hard link", [{ name: `${TOP}/link`, type: "hardlink", linkTarget: `${TOP}/VERSION` }]],
    ["a character device", [{ name: `${TOP}/tty`, type: "char" }]],
    ["a block device", [{ name: `${TOP}/sda`, type: "block" }]],
    ["a FIFO", [{ name: `${TOP}/fifo`, type: "fifo" }]],
    ["a GNU long name", [{ name: "././@LongLink", type: "L", content: `${TOP}/x\0` }]],
    ["a global pax header", [{ name: "pax_global_header", type: "g", content: "11 path=x\n" }]],
    ["a sparse file", [{ name: `${TOP}/sparse`, content: "x", pax: { "GNU.sparse.major": "1" } }]],
    ["a setuid file", [{ name: `${TOP}/su`, content: "x", mode: 0o4755 }]],
    ["a setgid file", [{ name: `${TOP}/sg`, content: "x", mode: 0o2755 }]],
    ["a sticky folder", [{ name: `${TOP}/tmp/`, type: "directory", mode: 0o1777 }]],
    [
      "a duplicate name",
      [
        { name: `${TOP}/VERSION`, content: "1.5.0\n" },
        { name: `${TOP}/VERSION`, content: "9.9.9\n" },
      ],
    ],
    [
      "a duplicate folder",
      [
        { name: `${TOP}/a/`, type: "directory" },
        { name: `${TOP}/a/`, type: "directory" },
      ],
    ],
    [
      "a file where a folder was made",
      [
        { name: `${TOP}/a/b`, content: "x" },
        { name: `${TOP}/a`, content: "x" },
      ],
    ],
    [
      "an entry below a file",
      [
        { name: `${TOP}/a`, content: "x" },
        { name: `${TOP}/a/b`, content: "x" },
      ],
    ],
    [
      "an entry below an allowed symlink",
      [
        { name: `${TOP}/release/node_modules/pkg`, type: "symlink", linkTarget: ".pnpm/pkg" },
        { name: `${TOP}/release/node_modules/pkg/index.js`, content: "x" },
      ],
    ],
    ["a symlink outside node_modules", [{ name: `${TOP}/release/dist/link`, type: "symlink", linkTarget: "main.js" }]],
    ["a symlink in the top folder", [{ name: `${TOP}/link`, type: "symlink", linkTarget: "VERSION" }]],
    ["an absolute symlink", [{ name: `${TOP}/release/node_modules/pkg`, type: "symlink", linkTarget: "/etc" }]],
    ["a symlink out of release/", [{ name: `${TOP}/release/node_modules/pkg`, type: "symlink", linkTarget: "../../install.sh" }]],
    ["a symlink far out", [{ name: `${TOP}/release/node_modules/pkg`, type: "symlink", linkTarget: "../../../../../../etc/shadow" }]],
    ["a symlink with .. after a name", [{ name: `${TOP}/release/node_modules/pkg`, type: "symlink", linkTarget: "other/../.pnpm" }]],
    ["a symlink with a . component", [{ name: `${TOP}/release/node_modules/pkg`, type: "symlink", linkTarget: "./.pnpm" }]],
    ["an empty symlink", [{ name: `${TOP}/release/node_modules/pkg`, type: "symlink", linkTarget: "" }]],
    [
      "a symlink named by a pax path outside",
      [{ name: `${TOP}/release/node_modules/pkg`, type: "symlink", linkTarget: ".pnpm/pkg", pax: { path: `${TOP}/link` } }],
    ],
  ])("refuses %s", async (_case, entries) => {
    expect(await refusal(tarGz([{ name: `${TOP}/`, type: "directory" }, ...entries]))).toBe("archive-unsafe");
    await expect(lstat(join(root, "escape"))).rejects.toThrow(/ENOENT/u);
  });

  it("refuses an entry outside the top folder even before the top folder's own entry", async () => {
    expect(await refusal(tarGz([{ name: "x/VERSION", content: "1.5.0\n" }]))).toBe("archive-unsafe");
  });

  it("allows a symlink up to release/ itself", async () => {
    const entries: TarEntry[] = [
      { name: `${TOP}/`, type: "directory" },
      { name: `${TOP}/release/node_modules/.bin/`, type: "directory" },
      { name: `${TOP}/release/node_modules/.bin/self`, type: "symlink", linkTarget: "../.." },
    ];
    expect(await refusal(tarGz(entries))).toBe("none");
  });

  it(`refuses more than ${MAX_ENTRIES} entries`, async () => {
    const entries: TarEntry[] = [{ name: `${TOP}/`, type: "directory" }];
    for (let index = 0; index < MAX_ENTRIES; index += 1) entries.push({ name: `${TOP}/${index}/`, type: "directory" });
    await writeFile(tarball, tarGz(entries));
    expect(await problemOf(checkReleaseArchive(tarball, TOP))).toBe("archive-unsafe");
  }, 120_000);

  // The sizes are only claimed: the refusal comes at the header, before the bytes would have to be there.
  it.each<[string, TarEntry[]]>([
    ["one file over 1 GiB", [{ name: `${TOP}/big`, headerSize: 1025 * 1024 * 1024 }]],
    ["a pax size over 1 GiB", [{ name: `${TOP}/big`, pax: { size: String(2 * 1024 * 1024 * 1024) } }]],
  ])("refuses %s unpacked", async (_case, entries) => {
    await writeFile(tarball, gzipSync(tar(entries, { end: false })));
    expect(await problemOf(checkReleaseArchive(tarball, TOP))).toBe("archive-unsafe");
  });

  it("refuses files that together pass 1 GiB", async () => {
    const half = 600 * 1024 * 1024;
    // A stream of headers and zeros, never all in memory: gzip of zeros is small.
    async function* pieces(): AsyncGenerator<Buffer> {
      const zeros = Buffer.alloc(1024 * 1024);
      yield tar([{ name: `${TOP}/a`, headerSize: half }], { end: false });
      for (let written = 0; written < half; written += zeros.byteLength) yield zeros;
      yield tar([{ name: `${TOP}/b`, headerSize: half }], { end: false });
    }
    await pipeline(pieces(), createGzip({ level: 1 }), createWriteStream(tarball));
    expect(await problemOf(checkReleaseArchive(tarball, TOP))).toBe("archive-unsafe");
  }, 120_000);
});

describe("archive-invalid", () => {
  it("refuses a file that isn't gzip", async () => {
    expect(await refusal(tar(good()))).toBe("archive-invalid");
  });

  it("refuses gzip that isn't a tar", async () => {
    expect(await refusal(gzipSync(Buffer.from("just some text, not a tar at all\n".repeat(40))))).toBe("archive-invalid");
  });

  it("refuses an empty file", async () => {
    expect(await refusal(Buffer.alloc(0))).toBe("archive-invalid");
  });

  it("refuses a truncated gzip stream", async () => {
    const archive = tarGz(good());
    expect(await refusal(archive.subarray(0, archive.byteLength - 40))).toBe("archive-invalid");
  });

  it("refuses a tar cut in a file's data", async () => {
    const whole = tar(good(), { end: false });
    expect(await refusal(gzipSync(whole.subarray(0, whole.byteLength - 300)))).toBe("archive-invalid");
  });

  it("refuses a tar without its end marker", async () => {
    expect(await refusal(tarGz(good(), { end: false }))).toBe("archive-invalid");
  });

  it("refuses data after the end marker", async () => {
    expect(await refusal(gzipSync(Buffer.concat([tar(good()), tar([{ name: `${TOP}/late`, content: "x" }])])))).toBe("archive-invalid");
  });

  it("refuses a header with a wrong checksum", async () => {
    const raw = tar(good());
    raw[0] = (raw[0] ?? 0) ^ 1;
    expect(await refusal(gzipSync(raw))).toBe("archive-invalid");
  });

  it("refuses a header that isn't ustar", async () => {
    expect(await refusal(tarGz(good(), { magic: "ustar  \0" }))).toBe("archive-invalid");
  });

  it("refuses a malformed pax record", async () => {
    const entries: TarEntry[] = [{ name: `${TOP}/`, type: "directory" }];
    const body = Buffer.from("99 path=x\n");
    const raw = Buffer.concat([tar([{ name: "PaxHeaders/x", type: "x", content: body }], { end: false }), tar(entries)]);
    expect(await refusal(gzipSync(raw))).toBe("archive-invalid");
  });
});
