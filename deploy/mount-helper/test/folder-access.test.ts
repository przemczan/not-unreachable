import { describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the shared rules are one file, not a module with an index.ts.
import {
  allowedFolderPrefixProblem,
  forbiddenRootOverlap,
  parseAllowedFolderPrefixes,
  touchesSystemFolder,
  withinAllowedPrefixes,
} from "../src/folder-access.mts";

describe("allowedFolderPrefixProblem", () => {
  it.each(["/srv", "/mnt", "/srv/media", "/home", "/data/shares", "/media/usb disk"])("allows %j", (prefix) => {
    expect(allowedFolderPrefixProblem(prefix)).toBeUndefined();
  });

  it.each([
    ["/", "never"],
    ["srv", "not an absolute path"],
    ["./srv", "not an absolute path"],
    ["", "not an absolute path"],
    ["/srv\n/etc", "not an absolute path"],
    ["/srv/../etc", "not a normalized path"],
    ["/srv/./media", "not a normalized path"],
    ["/srv//media", "not a normalized path"],
    ["/srv/", "not a normalized path"],
    ["/etc", "system folder"],
    ["/etc/not-unreachable", "system folder"],
    ["/var", "system folder"],
    ["/var/lib", "system folder"],
    ["/usr/local", "system folder"],
    ["/tmp", "system folder"],
    ["/root", "system folder"],
    ["/run/media", "system folder"],
  ])("refuses %j", (prefix, reason) => {
    expect(allowedFolderPrefixProblem(prefix)).toContain(reason);
  });

  it("checks against the system folders it is given", () => {
    expect(allowedFolderPrefixProblem("/tmp/x", ["/etc"])).toBeUndefined();
    expect(allowedFolderPrefixProblem("/data", ["/data/system"])).toContain("system folder");
  });
});

describe("parseAllowedFolderPrefixes", () => {
  it("splits on commas, trims and drops empty entries", () => {
    expect(parseAllowedFolderPrefixes(" /srv, /mnt ,,/data ")).toEqual(["/srv", "/mnt", "/data"]);
    expect(parseAllowedFolderPrefixes("")).toEqual([]);
  });
});

describe("touchesSystemFolder", () => {
  it.each(["/", "/etc", "/etc/ssh", "/usr", "/usr/share/x", "/var/lib/not-unreachable", "/proc/self", "/boot/efi"])(
    "is true for %j",
    (path) => {
      expect(touchesSystemFolder(path)).toBe(true);
    },
  );

  // A name that only starts like a system folder is not one.
  it.each(["/srv", "/srv/media", "/mnt/usb", "/home/alice", "/etcetera", "/usr2", "/data/etc"])("is false for %j", (path) => {
    expect(touchesSystemFolder(path)).toBe(false);
  });
});

describe("withinAllowedPrefixes", () => {
  const prefixes = ["/srv", "/mnt/shares"];

  it.each(["/srv", "/srv/media", "/srv/media/photos", "/mnt/shares", "/mnt/shares/a"])("is true for %j", (path) => {
    expect(withinAllowedPrefixes(path, prefixes)).toBe(true);
  });

  it.each(["/srv2", "/srv2/media", "/srvx", "/mnt", "/mnt/sharesx", "/home/srv", "/"])("is false for %j", (path) => {
    expect(withinAllowedPrefixes(path, prefixes)).toBe(false);
  });

  it("allows nothing without prefixes", () => {
    expect(withinAllowedPrefixes("/srv", [])).toBe(false);
  });
});

describe("forbiddenRootOverlap", () => {
  const roots = { dataDir: "/data/app", releaseDir: "/opt/not-unreachable", mountRoot: "/srv/not-unreachable/mounts" };

  it.each([
    ["/data/app", "inside-data-directory"],
    ["/data/app/db", "inside-data-directory"],
    ["/data", "inside-data-directory"],
    ["/", "inside-data-directory"],
    ["/opt/not-unreachable/current", "inside-release-directory"],
    ["/opt", "inside-release-directory"],
    ["/srv/not-unreachable/mounts/x", "inside-mount-root"],
    ["/srv/not-unreachable", "inside-mount-root"],
    ["/srv", "inside-mount-root"],
  ])("names %j as %s", (path, overlap) => {
    expect(forbiddenRootOverlap(path, roots)).toBe(overlap);
  });

  it.each(["/srv/media", "/data/app2", "/data/other", "/srv/not-unreachable2", "/mnt/usb"])("is undefined for %j", (path) => {
    expect(forbiddenRootOverlap(path, roots)).toBeUndefined();
  });
});
