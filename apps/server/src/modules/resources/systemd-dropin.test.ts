import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/index.ts";
import { addFolderToDropIn, dropInContent, foldersInDropIn, systemdPath, UnsupportedFolderPathError } from "./index.ts";

const HEADER =
  "# Managed by `not-unreachable allow-folder`, which rewrites this file: add folders with it, not by hand.\n" +
  "# The local folders mapped as resources, which the service may write to (ProtectSystem=strict).\n";

describe("the allow-folder systemd drop-in", () => {
  let temp: ReturnType<typeof makeTempDir>;
  let dropInDir: string;

  beforeEach(() => {
    temp = makeTempDir();
    dropInDir = join(temp.dir, "not-unreachable.service.d");
  });
  afterEach(() => temp.cleanup());

  it("writes one ReadWritePaths= line per folder, sorted, mode 0644 in a 0755 folder", async () => {
    expect(await addFolderToDropIn(dropInDir, "/srv/photos")).toEqual({
      file: join(dropInDir, "resources.conf"),
      folders: ["/srv/photos"],
      changed: true,
    });
    expect(await addFolderToDropIn(dropInDir, "/mnt/archive")).toMatchObject({ folders: ["/mnt/archive", "/srv/photos"], changed: true });
    const file = join(dropInDir, "resources.conf");
    expect(readFileSync(file, "utf8")).toBe(`${HEADER}[Service]\nReadWritePaths=/mnt/archive\nReadWritePaths=/srv/photos\n`);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(statSync(dropInDir).mode & 0o777).toBe(0o755);
    expect(readdirSync(dropInDir)).toEqual(["resources.conf"]);
  });

  it("changes nothing when the folder is listed already", async () => {
    await addFolderToDropIn(dropInDir, "/srv/photos");
    const before = statSync(join(dropInDir, "resources.conf")).mtimeMs;
    expect(await addFolderToDropIn(dropInDir, "/srv/photos")).toMatchObject({ folders: ["/srv/photos"], changed: false });
    expect(statSync(join(dropInDir, "resources.conf")).mtimeMs).toBe(before);
  });

  it("hides home folders behind ProtectHome=tmpfs and binds each one back", () => {
    expect(dropInContent(["/srv/a", "/home/alice/files", "/root/x", "/homework"])).toBe(
      `${HEADER}[Service]\n` +
        "ReadWritePaths=/home/alice/files\n" +
        "ReadWritePaths=/homework\n" +
        "ReadWritePaths=/root/x\n" +
        "ReadWritePaths=/srv/a\n" +
        "# Folders under /home, /root or /run/user, which ProtectHome=yes hides: an empty tmpfs there instead,\n" +
        "# with each folder bound back in.\n" +
        "ProtectHome=tmpfs\n" +
        "BindPaths=/home/alice/files\n" +
        "BindPaths=/root/x\n",
    );
  });

  it("quotes paths with spaces, doubles % and reads its own file back", async () => {
    expect(systemdPath("/srv/my files")).toBe('"/srv/my files"');
    expect(systemdPath("/srv/it's")).toBe(`"/srv/it's"`);
    expect(systemdPath("/home/me/a:b")).toBe('"/home/me/a:b"');
    expect(systemdPath("/srv/100%")).toBe("/srv/100%%");
    for (const bad of ["/srv/a\\b", '/srv/a"b', "/srv/a\nb"]) expect(() => systemdPath(bad)).toThrow(UnsupportedFolderPathError);

    const folders = ["/home/me/My Files", "/srv/100% sure", "/srv/plain"];
    for (const folder of folders) await addFolderToDropIn(dropInDir, folder);
    const content = readFileSync(join(dropInDir, "resources.conf"), "utf8");
    expect(content).toContain('ReadWritePaths="/home/me/My Files"\n');
    expect(content).toContain('BindPaths="/home/me/My Files"\n');
    expect(content).toContain('ReadWritePaths="/srv/100%% sure"\n');
    expect(foldersInDropIn(content)).toEqual(folders);
  });

  it("keeps the folders of a file it finds", async () => {
    await addFolderToDropIn(dropInDir, "/srv/b");
    await addFolderToDropIn(dropInDir, "/srv/a");
    expect(foldersInDropIn(readFileSync(join(dropInDir, "resources.conf"), "utf8"))).toEqual(["/srv/a", "/srv/b"]);
  });
});
