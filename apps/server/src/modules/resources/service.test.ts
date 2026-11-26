import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditAction, NewResource } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureLogger,
  fakeClock,
  makeStorageRoot,
  migratedMemoryDatabase,
  testSecrets,
  type FakeClock,
} from "../../test-support/index.ts";
import { createAuditService, type AuditActor, type AuditService } from "../audit/index.ts";
import type { Database } from "../platform/index.ts";
import { createSettingsService } from "../settings/index.ts";
import { NameTakenError, PathRefusedError, type FixedRoot } from "../storage/index.ts";
import {
  allowFolderCommand,
  createResourcesService,
  FolderRefusedError,
  HomeNotFoundError,
  HomeRootNotSetError,
  ResourceInUseError,
  ResourceNameTakenError,
  ResourceNotFoundError,
  ResourceUnavailableError,
  shellQuote,
  type ResourceRootsOptions,
  type ResourcesService,
} from "./index.ts";

const actor: AuditActor = { kind: "account", accountId: "01900000-0000-7000-8000-0000000000aa", username: "admin" };
const origin = { ip: "127.0.0.1", userAgent: "test" };

const local = (name: string, localPath: string): NewResource => ({ kind: "local", name, localPath });
const localCheck = (localPath: string) => ({ kind: "local", localPath }) as const;
const notWritable = async (): Promise<FixedRoot> => ({ ok: false, reason: "not-writable" });

/** The reason and command of the FolderRefusedError `work` fails with. */
async function refusal(work: Promise<unknown>): Promise<{ reason: string; command: string | null }> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof FolderRefusedError)) throw new Error(`Expected a FolderRefusedError, got ${String(error)}`);
  return { reason: error.reason, command: error.command };
}

describe("the resources service", () => {
  let storage: ReturnType<typeof makeStorageRoot>;
  let dir: string;
  let database: Database;
  let clock: FakeClock;
  let audit: AuditService;
  let roots: ResourceRootsOptions;
  let service: ResourcesService;
  let logs: () => Record<string, unknown>[];

  function serviceWith(extra: Partial<ResourceRootsOptions> = {}): ResourcesService {
    const captured = captureLogger("info");
    logs = captured.lines;
    return createResourcesService({
      db: database.db,
      clock,
      logger: captured.logger,
      audit,
      secrets: testSecrets,
      roots: { ...roots, ...extra },
    });
  }

  beforeEach(() => {
    storage = makeStorageRoot();
    dir = storage.dir;
    clock = fakeClock();
    mkdirSync(join(dir, "backups"));
    database = migratedMemoryDatabase(join(dir, "backups"), clock);
    const settings = createSettingsService({ db: database.db, clock, logger: captureLogger().logger });
    audit = createAuditService({ db: database.db, clock, logger: captureLogger().logger, settings });
    roots = { dataDir: join(dir, "d", "data"), releaseDir: join(dir, "r", "release"), mountRoot: join(dir, "m", "mounts") };
    service = serviceWith();
  });
  afterEach(() => {
    database.sqlite.close();
    storage.cleanup();
  });

  /** Makes a folder under the temp root; answers its path. */
  const folder = (...segments: string[]): string => {
    const path = join(dir, ...segments);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const audited = (action?: AuditAction) => audit.list({ limit: 100, ...(action === undefined ? {} : { action }) }).events;

  describe("adding a local folder", () => {
    it("stores its real path, answers the contract's fields and records resource.added once", async () => {
      const target = folder("files");
      symlinkSync(target, join(dir, "link"));
      const resource = await service.add(local("Files", join(dir, "link")), actor, origin);
      expect(resource).toEqual({
        id: expect.any(String),
        name: "Files",
        kind: "local",
        localPath: join(dir, "link"),
        state: "available",
        unavailableReason: null,
        isHomeRoot: false,
        createdAt: "2026-11-24T10:15:00.000Z",
      });
      expect(database.sqlite.prepare("SELECT root_realpath FROM resources").all()).toEqual([{ root_realpath: target }]);
      expect(service.get(resource.id)).toEqual(resource);
      expect(service.list()).toEqual({ resources: [resource], homeRoot: null });
      expect(audited()).toEqual([
        expect.objectContaining({
          action: "resource.added",
          actorUsername: "admin",
          targetKind: "resource",
          targetId: resource.id,
          outcome: "succeeded",
          details: { kind: "local", name: "Files" },
        }),
      ]);
    });

    it("refuses a name another resource has", async () => {
      await service.add(local("Files", folder("a")), actor);
      await expect(service.add(local("Files", folder("b")), actor)).rejects.toBeInstanceOf(ResourceNameTakenError);
      expect(audited("resource.added")).toHaveLength(1);
    });

    it("refuses a relative, missing or non-folder path", async () => {
      writeFileSync(join(dir, "file"), "x");
      expect(await refusal(service.add(local("A", "relative/path"), actor))).toEqual({ reason: "not-absolute", command: null });
      expect(await refusal(service.add(local("A", join(dir, "nope")), actor))).toEqual({ reason: "missing", command: null });
      expect(await refusal(service.add(local("A", join(dir, "file")), actor))).toEqual({ reason: "not-a-folder", command: null });
      expect(await refusal(service.add(local("A", `/${"x".repeat(4096)}`), actor))).toEqual({ reason: "missing", command: null });
      expect(audited()).toEqual([]);
    });

    const forbidden = [
      ["dataDir", "d", "data", "inside-data-directory"],
      ["releaseDir", "r", "release", "inside-release-directory"],
      ["mountRoot", "m", "mounts", "inside-mount-root"],
    ] as const;

    describe.each(forbidden)("against %s", (_key, parent, name, reason) => {
      it.each([
        ["equal to it", (): string => folder(parent, name)],
        ["inside it", (): string => folder(parent, name, "inner")],
        ["containing it", (): string => folder(parent)],
        ["inside it through a symlink", (): string => (symlinkSync(folder(parent, name, "x"), join(dir, "sneaky")), join(dir, "sneaky"))],
      ])("refuses a folder %s, and so does Check folder", async (_case, make) => {
        const path = make();
        expect(await refusal(service.add(local("A", path), actor))).toEqual({ reason, command: null });
        expect(await service.check({ kind: "local", localPath: path })).toEqual({
          outcome: "refused",
          reason,
          command: null,
          allowFromUi: false,
        });
      });

      it("refuses a folder containing it even before it exists", async () => {
        expect(existsSync(join(dir, parent, name))).toBe(false);
        expect(await refusal(service.add(local("A", folder(parent)), actor))).toEqual({ reason, command: null });
      });
    });

    it("never probes a folder inside the data directory for writability", async () => {
      const probed: string[] = [];
      service = serviceWith({
        fixRoot: async (absolute) => {
          probed.push(absolute);
          return { ok: false, reason: "not-writable" };
        },
      });
      await refusal(service.add(local("A", folder("d", "data", "x")), actor));
      expect(probed).toEqual([]);
    });

    it("answers a folder the service can't write to with the exact allow-folder command", async () => {
      service = serviceWith({ fixRoot: notWritable });
      const plain = folder("plain");
      expect(await refusal(service.add(local("A", plain), actor))).toEqual({
        reason: "not-writable",
        command: `sudo not-unreachable allow-folder ${plain}`,
      });
      const spaced = folder("my files");
      symlinkSync(spaced, join(dir, "alias"));
      expect(await service.check({ kind: "local", localPath: join(dir, "alias") })).toEqual({
        outcome: "refused",
        reason: "not-writable",
        command: `sudo not-unreachable allow-folder '${spaced}'`,
        allowFromUi: false,
      });
    });

    it("says a folder the service can't write to can be allowed from the admin interface only when it passes its rules", async () => {
      // Below /srv rather than the temp folder: /tmp is a system folder, which the admin interface never allows.
      const prefix = `/srv/nu-test-${clock.now().getTime()}`;
      const off = serviceWith({ fixRoot: notWritable });
      const on = serviceWith({ fixRoot: notWritable, allowFromUi: { allowedPrefixes: [prefix] } });
      // Even with the temp folder or /etc as a prefix: a system folder is never allowed.
      const lax = serviceWith({ fixRoot: notWritable, allowFromUi: { allowedPrefixes: [prefix, dir, "/etc"] } });

      expect(await off.check(localCheck(`${prefix}/photos`))).toMatchObject({ reason: "not-writable", allowFromUi: false });
      expect(await on.check(localCheck(`${prefix}/photos`))).toEqual({
        outcome: "refused",
        reason: "not-writable",
        command: `sudo not-unreachable allow-folder ${prefix}/photos`,
        allowFromUi: true,
      });
      expect(await on.check(localCheck("/mnt/elsewhere"))).toMatchObject({ allowFromUi: false });
      expect(await on.check(localCheck(`${prefix}/a"b`))).toMatchObject({ allowFromUi: false });
      expect(await lax.check(localCheck(folder("in-tmp")))).toMatchObject({ allowFromUi: false });
      symlinkSync("/etc", join(dir, "escape"));
      expect(await lax.check(localCheck(join(dir, "escape")))).toMatchObject({ allowFromUi: false });
    });

    it("quotes a path for the shell only when it must", () => {
      expect(shellQuote("/srv/files_2024/a-b.c")).toBe("/srv/files_2024/a-b.c");
      expect(shellQuote("/srv/my files")).toBe("'/srv/my files'");
      expect(shellQuote("/srv/it's")).toBe(String.raw`'/srv/it'\''s'`);
      expect(allowFolderCommand("/srv/$HOME")).toBe("sudo not-unreachable allow-folder '/srv/$HOME'");
    });

    it("Check folder answers ok and changes nothing", async () => {
      expect(await service.check({ kind: "local", localPath: folder("ok") })).toEqual({ outcome: "ok" });
      expect(service.list().resources).toEqual([]);
      expect(audited()).toEqual([]);
    });
  });

  describe("changing a resource", () => {
    it("records the changed fields only, and nothing for a no-op", async () => {
      const resource = await service.add(local("Files", folder("a")), actor);
      expect(await service.change(resource.id, { kind: "local", name: "Files" }, actor)).toEqual(resource);
      expect(await service.change(resource.id, { kind: "local", localPath: folder("a") }, actor)).toEqual(resource);
      expect(audited("resource.changed")).toEqual([]);

      const renamed = await service.change(resource.id, { kind: "local", name: "Shared" }, actor, origin);
      expect(renamed).toEqual({ ...resource, name: "Shared" });
      clock.advance(1000);
      const moved = await service.change(resource.id, { kind: "local", localPath: folder("b") }, actor);
      expect(moved).toEqual({ ...renamed, localPath: join(dir, "b") });
      expect(database.sqlite.prepare("SELECT root_realpath FROM resources").all()).toEqual([{ root_realpath: join(dir, "b") }]);
      expect(audited("resource.changed").map((event) => event.details)).toEqual([{ fields: ["localPath"] }, { fields: ["name"] }]);
    });

    it("refuses a taken name or a refused folder, and an unknown resource", async () => {
      const first = await service.add(local("One", folder("a")), actor);
      await service.add(local("Two", folder("b")), actor);
      await expect(service.change(first.id, { kind: "local", name: "Two" }, actor)).rejects.toBeInstanceOf(ResourceNameTakenError);
      expect(await refusal(service.change(first.id, { kind: "local", localPath: roots.dataDir }, actor))).toEqual({
        reason: "inside-data-directory",
        command: null,
      });
      await expect(service.change("01900000-0000-7000-8000-000000000000", { kind: "local" }, actor)).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
      expect(audited("resource.changed")).toEqual([]);
    });
  });

  describe("checking resources at startup", () => {
    it("marks a removed folder missing, a swapped one changed, and a restored one available on Retry", async () => {
      const a = folder("a");
      folder("b");
      const link = join(dir, "link");
      symlinkSync(a, link);
      const resource = await service.add(local("Files", link), actor);

      rmSync(a, { recursive: true });
      await service.checkAtStartup();
      expect(service.get(resource.id)).toMatchObject({ state: "unavailable", unavailableReason: "missing" });
      expect(() => service.rootFor(resource.id)).toThrow(ResourceUnavailableError);
      expect(logs()).toContainEqual(expect.objectContaining({ level: 40, resourceId: resource.id, reason: "missing" }));

      mkdirSync(a);
      expect(await service.retry(resource.id)).toMatchObject({ state: "available", unavailableReason: null });
      expect(service.rootFor(resource.id)).toBe(a);

      rmSync(link);
      symlinkSync(join(dir, "b"), link);
      await service.checkAtStartup();
      expect(service.get(resource.id)).toMatchObject({ state: "unavailable", unavailableReason: "changed" });

      rmSync(link);
      symlinkSync(a, link);
      expect(await service.retry(resource.id)).toMatchObject({ state: "available", unavailableReason: null });
      await service.checkAtStartup();
      expect(service.get(resource.id).state).toBe("available");
    });

    it("counts the resources by the state the list shows", async () => {
      expect(service.countByState()).toEqual({ available: 0, unavailable: 0 });
      await service.add(local("A", folder("a")), actor);
      await service.add(local("B", folder("b")), actor);
      const gone = await service.add(local("C", folder("c")), actor);
      expect(service.countByState()).toEqual({ available: 3, unavailable: 0 });

      rmSync(join(dir, "c"), { recursive: true });
      await service.checkAtStartup();
      expect(service.countByState()).toEqual({ available: 2, unavailable: 1 });
      expect(
        service
          .list()
          .resources.filter((resource) => resource.state === "unavailable")
          .map((resource) => resource.id),
      ).toEqual([gone.id]);
    });

    it("re-fixes the real path when the admin saves the path again", async () => {
      const link = join(dir, "link");
      symlinkSync(folder("a"), link);
      const resource = await service.add(local("Files", link), actor);
      rmSync(link);
      symlinkSync(folder("b"), link);
      await service.checkAtStartup();
      expect(service.get(resource.id).unavailableReason).toBe("changed");
      expect(await service.change(resource.id, { kind: "local", localPath: link }, actor)).toMatchObject({ state: "available" });
      expect(service.rootFor(resource.id)).toBe(join(dir, "b"));
    });

    it("answers rootFor an unknown resource with not found", () => {
      expect(() => service.rootFor("01900000-0000-7000-8000-000000000000")).toThrow(ResourceNotFoundError);
    });
  });

  describe("the home root and homes", () => {
    it("makes the subfolder, records home-root.changed, and keeps existing homes where they were", async () => {
      const first = await service.add(local("First", folder("first")), actor);
      const second = await service.add(local("Second", folder("second")), actor);
      expect(service.isHomeRootSet()).toBe(false);
      await expect(service.createHome("alice")).rejects.toBeInstanceOf(HomeRootNotSetError);

      expect(await service.setHomeRoot({ resourceId: first.id, subpath: "homes//users/" }, actor, origin)).toEqual({
        resourceId: first.id,
        subpath: "homes/users",
      });
      expect(lstatSync(join(dir, "first", "homes", "users")).isDirectory()).toBe(true);
      expect(service.isHomeRootSet()).toBe(true);
      expect(service.get(first.id).isHomeRoot).toBe(true);

      const alice = await service.createHome("alice");
      expect(alice).toBe(join(dir, "first", "homes", "users", "alice"));
      expect(lstatSync(alice).isDirectory()).toBe(true);
      expect(await service.createHome("alice")).toBe(alice);
      expect(await service.homeFor("alice")).toBe(alice);

      clock.advance(1000);
      await service.setHomeRoot({ resourceId: second.id, subpath: "" }, actor);
      expect(service.list().homeRoot).toEqual({ resourceId: second.id, subpath: "" });
      expect(service.get(first.id).isHomeRoot).toBe(false);
      expect(await service.createHome("bob")).toBe(join(dir, "second", "bob"));
      expect(await service.homeFor("alice")).toBe(alice);
      expect(await service.createHome("alice")).toBe(alice);
      expect(database.sqlite.prepare("SELECT username, resource_id, path FROM homes ORDER BY username").all()).toEqual([
        { username: "alice", resource_id: first.id, path: "homes/users/alice" },
        { username: "bob", resource_id: second.id, path: "bob" },
      ]);

      // The same home root again changes nothing.
      await service.setHomeRoot({ resourceId: second.id, subpath: "" }, actor);
      expect(audited("home-root.changed").map((event) => [event.targetId, event.details])).toEqual([
        [second.id, { previousResourceId: first.id, previousSubpath: "homes/users", subpath: "" }],
        [first.id, { previousResourceId: null, previousSubpath: null, subpath: "homes/users" }],
      ]);
    });

    it("refuses an unavailable resource, an unknown one and a bad subpath", async () => {
      const resource = await service.add(local("Files", folder("files")), actor);
      symlinkSync(folder("elsewhere"), join(dir, "files", "link"));
      await expect(service.setHomeRoot({ resourceId: resource.id, subpath: "../x" }, actor)).rejects.toMatchObject({
        name: "PathRefusedError",
        reason: "invalid",
      });
      await expect(service.setHomeRoot({ resourceId: resource.id, subpath: "link/homes" }, actor)).rejects.toMatchObject({
        reason: "symlink",
      });
      await expect(service.setHomeRoot({ resourceId: "01900000-0000-7000-8000-000000000000", subpath: "" }, actor)).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
      rmSync(join(dir, "files"), { recursive: true });
      await service.checkAtStartup();
      await expect(service.setHomeRoot({ resourceId: resource.id, subpath: "" }, actor)).rejects.toBeInstanceOf(ResourceUnavailableError);
      expect(service.isHomeRootSet()).toBe(false);
      expect(audited("home-root.changed")).toEqual([]);
    });

    it("refuses to make a home where a symlink has the user's name", async () => {
      const resource = await service.add(local("Files", folder("files")), actor);
      await service.setHomeRoot({ resourceId: resource.id, subpath: "" }, actor);
      symlinkSync(folder("elsewhere"), join(dir, "files", "mallory"));
      await expect(service.createHome("mallory")).rejects.toBeInstanceOf(PathRefusedError);
      await expect(service.homeFor("mallory")).rejects.toBeInstanceOf(HomeNotFoundError);
      expect(database.sqlite.prepare("SELECT * FROM homes").all()).toEqual([]);
    });

    it("never makes a folder that is already there a new user's home", async () => {
      const resource = await service.add(local("Files", folder("files")), actor);
      await service.setHomeRoot({ resourceId: resource.id, subpath: "homes" }, actor);
      await service.createHome("alice");
      writeFileSync(join(dir, "files", "homes", "alice", "diary.txt"), "alice's");
      writeFileSync(join(folder("files", "photos"), "family.jpg"), "the admin's");

      // The home root moves up: the old one, holding alice's home, and the admin's folders are now in it.
      await service.setHomeRoot({ resourceId: resource.id, subpath: "" }, actor);
      for (const username of ["homes", "photos"]) {
        await expect(service.createHome(username)).rejects.toBeInstanceOf(NameTakenError);
        await expect(service.homeFor(username)).rejects.toBeInstanceOf(HomeNotFoundError);
      }
      expect(database.sqlite.prepare("SELECT username FROM homes").all()).toEqual([{ username: "alice" }]);
      // A home already recorded is still answered as it was.
      expect(await service.createHome("alice")).toBe(join(dir, "files", "homes", "alice"));
    });

    it("answers homeFor a home whose folder became a file with a refusal", async () => {
      const resource = await service.add(local("Files", folder("files")), actor);
      await service.setHomeRoot({ resourceId: resource.id, subpath: "" }, actor);
      const home = await service.createHome("carol");
      rmSync(home, { recursive: true });
      writeFileSync(home, "x");
      await expect(service.homeFor("carol")).rejects.toMatchObject({ reason: "not-a-folder" });
    });
  });

  describe("removing a resource", () => {
    it("refuses the home root's resource and one holding homes; never deletes files", async () => {
      const first = await service.add(local("First", folder("first")), actor);
      const second = await service.add(local("Second", folder("second")), actor);
      await service.setHomeRoot({ resourceId: first.id, subpath: "" }, actor);
      await expect(service.remove(first.id, actor)).rejects.toMatchObject({ reason: "home-root" });
      await service.createHome("alice");
      await service.setHomeRoot({ resourceId: second.id, subpath: "" }, actor);
      await expect(service.remove(first.id, actor)).rejects.toBeInstanceOf(ResourceInUseError);
      await expect(service.remove(first.id, actor)).rejects.toMatchObject({ reason: "holds-homes" });

      const third = await service.add(local("Third", folder("third")), actor);
      writeFileSync(join(dir, "third", "keep.txt"), "keep");
      await service.remove(third.id, actor, origin);
      expect(existsSync(join(dir, "third", "keep.txt"))).toBe(true);
      expect(() => service.get(third.id)).toThrow(ResourceNotFoundError);
      expect(audited("resource.removed")).toEqual([
        expect.objectContaining({ targetId: third.id, details: { kind: "local", name: "Third" } }),
      ]);
      await expect(service.remove(third.id, actor)).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect(service.list().resources.map((resource) => resource.name)).toEqual(["First", "Second"]);
    });
  });
});
