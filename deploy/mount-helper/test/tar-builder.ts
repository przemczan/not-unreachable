import { gzipSync } from "node:zlib";

/** One entry of a tar built in a test; anything a real tar could hold, and a few it shouldn't. */
export interface TarEntry {
  readonly name: string;
  /** A typeflag by name, or the raw typeflag character. */
  readonly type?: "file" | "directory" | "symlink" | "hardlink" | "char" | "block" | "fifo" | (string & {});
  readonly content?: string | Buffer;
  readonly mode?: number;
  readonly linkTarget?: string;
  /** Extra pax records, before the entry's own header. */
  readonly pax?: Readonly<Record<string, string>>;
  /** The size the header claims, when it isn't the content's. */
  readonly headerSize?: number;
  /** Write the name into the ustar header even when it is too long (cut), for a pax path that differs. */
  readonly ustarName?: string;
}

const TYPEFLAGS: Readonly<Record<string, string>> = {
  file: "0",
  directory: "5",
  symlink: "2",
  hardlink: "1",
  char: "3",
  block: "4",
  fifo: "6",
};

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(name: string, typeflag: string, size: number, mode: number, linkTarget: string, magic = "ustar\u000000"): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(octal(mode, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1");
  block.write(octal(0, 8), 116, "latin1");
  block.write(octal(size, 12), 124, "latin1");
  block.write(octal(0, 12), 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(typeflag, 156, "latin1");
  block.write(linkTarget.slice(0, 100), 157, "utf8");
  block.write(magic, 257, "latin1");
  block.write("root", 265, "latin1");
  block.write("root", 297, "latin1");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function padded(content: Buffer): Buffer {
  const padding = (512 - (content.byteLength % 512)) % 512;
  return Buffer.concat([content, Buffer.alloc(padding)]);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
  return `${length}${body}`;
}

/** A tar stream with the end marker; long names and targets go into pax records, as GNU tar --format=pax writes them. */
export function tar(entries: readonly TarEntry[], { end = true, magic }: { end?: boolean; magic?: string } = {}): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "file";
    const typeflag = TYPEFLAGS[type] ?? type;
    const content = Buffer.from(entry.content ?? "");
    const linkTarget = entry.linkTarget ?? "";
    const records: Record<string, string> = { ...entry.pax };
    if (Buffer.byteLength(entry.name) > 100 && entry.ustarName === undefined) records["path"] ??= entry.name;
    if (Buffer.byteLength(linkTarget) > 100) records["linkpath"] ??= linkTarget;
    if (Object.keys(records).length > 0) {
      const body = Buffer.from(
        Object.entries(records)
          .map(([key, value]) => paxRecord(key, value))
          .join(""),
      );
      blocks.push(header(`PaxHeaders/${entry.name.slice(-80)}`, "x", body.byteLength, 0o644, "", magic), padded(body));
    }
    const mode = entry.mode ?? (type === "directory" ? 0o755 : 0o644);
    blocks.push(header(entry.ustarName ?? entry.name, typeflag, entry.headerSize ?? content.byteLength, mode, linkTarget, magic));
    if (content.byteLength > 0) blocks.push(padded(content));
  }
  if (end) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function tarGz(entries: readonly TarEntry[], options?: { end?: boolean; magic?: string }): Buffer {
  return gzipSync(tar(entries, options));
}

/** The entries of a release bundle as `assemble-bundle.sh` lays it out, with a symlink as `pnpm deploy` writes. */
export function releaseEntries(top: string, version: string, arch: string, installScript = "#!/usr/bin/env bash\nexit 0\n"): TarEntry[] {
  return [
    { name: `${top}/`, type: "directory" },
    { name: `${top}/ARCH`, content: `${arch}\n` },
    { name: `${top}/VERSION`, content: `${version}\n` },
    { name: `${top}/install.sh`, content: installScript, mode: 0o755 },
    { name: `${top}/release/`, type: "directory" },
    { name: `${top}/release/dist/`, type: "directory" },
    { name: `${top}/release/dist/main.js`, content: "console.log('hello');\n" },
    { name: `${top}/release/node_modules/`, type: "directory" },
    { name: `${top}/release/node_modules/.pnpm/`, type: "directory" },
    { name: `${top}/release/node_modules/.pnpm/zod@4.0.0/`, type: "directory" },
    { name: `${top}/release/node_modules/.pnpm/zod@4.0.0/node_modules/`, type: "directory" },
    { name: `${top}/release/node_modules/.pnpm/zod@4.0.0/node_modules/zod/`, type: "directory" },
    { name: `${top}/release/node_modules/.pnpm/zod@4.0.0/node_modules/zod/index.js`, content: "export {};\n" },
    { name: `${top}/release/node_modules/zod`, type: "symlink", linkTarget: ".pnpm/zod@4.0.0/node_modules/zod" },
  ];
}
