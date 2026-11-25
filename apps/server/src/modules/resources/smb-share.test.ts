import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditAction, NewResource, Resource } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureLogger,
  fakeClock,
  fakeMountRunner,
  makeStorageRoot,
  migratedMemoryDatabase,
  testSecrets,
  writeMountInfo,
  type FakeClock,
  type FakeMountRunner,
} from "../../test-support/index.ts";
import { createAuditService, type AuditActor, type AuditService } from "../audit/index.ts";
import { createSecrets, envelopeColumns, MINUTE_MS, rotateMasterKey, type Database } from "../platform/index.ts";
import { createSettingsService } from "../settings/index.ts";
import {
  createResourcesService,
  ResourceNotFoundError,
  SharePasswordRequiredError,
  ShareRefusedError,
  type ResourcesService,
} from "./index.ts";

const actor: AuditActor = { kind: "account", accountId: "01900000-0000-7000-8000-0000000000aa", username: "admin" };
const PASSWORD = "s3cret-Pa55word";

type NewShare = Extract<NewResource, { kind: "smb" }>;

/** The connection settings of {@link share}, without its name and password. */
const connection = {
  host: "nas.local",
  share: "Photos",
  subfolder: "",
  username: "alice",
  domain: "",
  protocol: "3.1.1",
  encrypt: true,
} as const;

const share = (overrides: Partial<NewShare> = {}): NewShare => ({
  kind: "smb",
  name: "NAS",
  ...connection,
  password: PASSWORD,
  ...overrides,
});

const passwordAad = (id: string) => ({ table: "resources", column: "smb_password", rowId: id });

/** The ShareFailure the ShareRefusedError `work` fails with. */
async function shareRefusal(work: Promise<unknown>): Promise<string> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ShareRefusedError)) throw new Error(`Expected a ShareRefusedError, got ${String(error)}`);
  return error.reason;
}

describe("SMB shares in the resources service", () => {
  let storage: ReturnType<typeof makeStorageRoot>;
  let database: Database;
  let clock: FakeClock;
  let audit: AuditService;
  let runner: FakeMountRunner;
  let mountRoot: string;
  let requestsDir: string;
  let mountInfo: string;
  let service: ResourcesService;
  let logs: () => Record<string, unknown>[];

  /** A new service over the same database and runner, as after a restart of the app. */
  function restart(): ResourcesService {
    const captured = captureLogger("info");
    logs = captured.lines;
    return createResourcesService({
      db: database.db,
      clock,
      logger: captured.logger,
      audit,
      secrets: testSecrets,
      roots: {
        dataDir: join(storage.dir, "data"),
        releaseDir: join(storage.dir, "release"),
        mountRoot,
        mountRequestsDir: requestsDir,
        mountInfoPath: mountInfo,
        mountRunner: runner,
      },
    });
  }

  beforeEach(() => {
    storage = makeStorageRoot();
    clock = fakeClock();
    mkdirSync(join(storage.dir, "backups"));
    database = migratedMemoryDatabase(join(storage.dir, "backups"), clock);
    const settings = createSettingsService({ db: database.db, clock, logger: captureLogger().logger });
    audit = createAuditService({ db: database.db, clock, logger: captureLogger().logger, settings });
    mountRoot = join(storage.dir, "mounts");
    mkdirSync(mountRoot);
    requestsDir = join(storage.dir, "requests");
    mountInfo = join(storage.dir, "mountinfo");
    writeMountInfo(mountInfo, []);
    runner = fakeMountRunner({ mountRoot, requestsDir });
    service = restart();
  });
  afterEach(() => {
    database.sqlite.close();
    storage.cleanup();
  });

  const audited = (action?: AuditAction) => audit.list({ limit: 100, ...(action === undefined ? {} : { action }) }).events;
  const storedPassword = (id: string): unknown =>
    database.sqlite.prepare("SELECT smb_password FROM resources WHERE id = ?").pluck().get(id);
  const startsOf = (id: string) => runner.calls.filter((call) => call === `start ${id}`).length;
  const lastRequest = () => runner.requests.at(-1)?.request;
  const add = async (overrides: Partial<NewShare> = {}): Promise<Resource> => service.add(share(overrides), actor);

  describe("adding a share", () => {
    it("hands the helper a 0600 request, mounts it and stores only an envelope of the password", async () => {
      const resource = await add();
      expect(resource).toEqual({
        id: expect.any(String),
        name: "NAS",
        kind: "smb",
        host: "nas.local",
        share: "Photos",
        subfolder: "",
        username: "alice",
        domain: "",
        protocol: "3.1.1",
        encrypt: true,
        smbPasswordSet: true,
        state: "available",
        unavailableReason: null,
        isHomeRoot: false,
        createdAt: "2026-11-24T10:15:00.000Z",
      });
      expect(runner.requests).toEqual([
        {
          id: resource.id,
          mode: 0o600,
          request: {
            host: "nas.local",
            share: "Photos",
            subfolder: "",
            username: "alice",
            password: PASSWORD,
            domain: "",
            vers: "3.1.1",
            seal: true,
          },
        },
      ]);
      expect(readdirSync(requestsDir)).toEqual([]);
      expect(database.sqlite.prepare("SELECT root_realpath FROM resources").pluck().get()).toBe(join(mountRoot, resource.id));

      const envelope = String(storedPassword(resource.id));
      expect(envelope).not.toContain(PASSWORD);
      expect(testSecrets.decrypt("smb", passwordAad(resource.id), envelope)).toBe(PASSWORD);
      expect(() => testSecrets.decrypt("smb", passwordAad("another-row"), envelope)).toThrow("failed authentication");

      expect(JSON.stringify([resource, service.list(), service.get(resource.id), audited()])).not.toContain(PASSWORD);
      expect(audited("resource.added")).toEqual([
        expect.objectContaining({ targetId: resource.id, details: { kind: "smb", name: "NAS" } }),
      ]);
    });

    it("never asks for encryption on SMB 2.1", async () => {
      const resource = await add({ protocol: "2.1", encrypt: true, subfolder: "Photos/2026", domain: "HOME" });
      expect(resource).toMatchObject({ protocol: "2.1", encrypt: false, subfolder: "Photos/2026", domain: "HOME" });
      expect(lastRequest()).toMatchObject({ vers: "2.1", seal: false, subfolder: "Photos/2026", domain: "HOME" });
    });

    it("saves nothing when the share doesn't mount, and leaves no request file", async () => {
      runner.failWith = "auth";
      expect(await shareRefusal(add())).toBe("auth");
      expect(service.list().resources).toEqual([]);
      expect(readdirSync(requestsDir)).toEqual([]);
      expect(audited("resource.added")).toEqual([]);
    });

    it("unmounts a share whose mount point the service can't use", async () => {
      const failing = createResourcesService({
        db: database.db,
        clock,
        logger: captureLogger().logger,
        audit,
        secrets: testSecrets,
        roots: {
          dataDir: join(storage.dir, "data"),
          mountRoot,
          mountRequestsDir: requestsDir,
          mountInfoPath: mountInfo,
          mountRunner: runner,
          fixRoot: async () => ({ ok: false, reason: "not-writable" }),
        },
      });
      expect(await shareRefusal(failing.add(share(), actor))).toBe("mount-failed");
      expect(runner.active.size).toBe(0);
      expect(service.list().resources).toEqual([]);
    });

    it("refuses SMB shares without the master key", async () => {
      const keyless = createResourcesService({
        db: database.db,
        clock,
        logger: captureLogger().logger,
        audit,
        secrets: undefined,
        roots: { dataDir: join(storage.dir, "data"), mountRoot, mountRequestsDir: requestsDir, mountRunner: runner },
      });
      await expect(keyless.add(share(), actor)).rejects.toThrow("SMB shares need the master key");
      expect(keyless.list().resources).toEqual([]);
      // Not saved, so not left mounted either.
      expect(runner.active.size).toBe(0);
    });
  });

  describe("Test connection", () => {
    it("mounts under a temporary id, counts the top folder's folders and unmounts", async () => {
      runner.onMount = (mountPoint) => {
        mkdirSync(join(mountPoint, "Holidays"));
        mkdirSync(join(mountPoint, "Family"));
        writeFileSync(join(mountPoint, "notes.txt"), "x");
      };
      expect(await service.check({ kind: "smb", ...connection, password: PASSWORD })).toEqual({ outcome: "connected", folderCount: 2 });
      const [received] = runner.requests;
      expect(received?.request).toMatchObject({ password: PASSWORD });
      expect(runner.calls).toEqual([`start ${String(received?.id)}`, `stop ${String(received?.id)}`]);
      expect(runner.active.size).toBe(0);
      expect(existsSync(join(mountRoot, String(received?.id)))).toBe(false);
      expect(service.list().resources).toEqual([]);
    });

    it("answers why it failed, and still stops the unit", async () => {
      runner.failWith = "unreachable";
      expect(await service.check({ kind: "smb", ...connection, password: PASSWORD })).toEqual({ outcome: "failed", reason: "unreachable" });
      const id = String(runner.requests[0]?.id);
      expect(runner.calls).toEqual([`start ${id}`, `stop ${id}`]);
      expect(readdirSync(requestsDir)).toEqual([]);
    });

    it("uses a saved share's stored password when none is given", async () => {
      const resource = await add();
      expect(await service.check({ kind: "smb", ...connection, resourceId: resource.id })).toEqual({
        outcome: "connected",
        folderCount: 0,
      });
      expect(lastRequest()).toMatchObject({ password: PASSWORD });
      expect(runner.requests.at(-1)?.id).not.toBe(resource.id);
      await expect(
        service.check({ kind: "smb", ...connection, resourceId: "01900000-0000-7000-8000-000000000999" }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("never tries the stored password on another server", async () => {
      const resource = await add();
      const requestsBefore = runner.requests.length;
      await expect(service.check({ kind: "smb", ...connection, host: "attacker.example", resourceId: resource.id })).rejects.toBeInstanceOf(
        SharePasswordRequiredError,
      );
      expect(runner.requests).toHaveLength(requestsBefore);
    });
  });

  describe("changing a share", () => {
    it("renames without remounting", async () => {
      const resource = await add();
      const changed = await service.change(resource.id, { kind: "smb", name: "Photos", host: "nas.local", encrypt: true }, actor);
      expect(changed).toEqual({ ...resource, name: "Photos" });
      expect(startsOf(resource.id)).toBe(1);
      expect(runner.calls).not.toContain(`stop ${resource.id}`);
      expect(audited("resource.changed")).toEqual([expect.objectContaining({ details: { fields: ["name"] } })]);
    });

    it("remounts on a connection field, and records which fields changed", async () => {
      const resource = await add();
      const changed = await service.change(resource.id, { kind: "smb", share: "Music", protocol: "3.0", encrypt: false }, actor);
      expect(changed).toEqual({ ...resource, share: "Music", protocol: "3.0", encrypt: false });
      expect(runner.calls.slice(-2)).toEqual([`stop ${resource.id}`, `start ${resource.id}`]);
      expect(lastRequest()).toMatchObject({ share: "Music", vers: "3.0", seal: false, password: PASSWORD });
      expect(audited("resource.changed")).toEqual([expect.objectContaining({ details: { fields: ["share", "protocol", "encrypt"] } })]);
    });

    it("never sends the stored password to another server", async () => {
      const resource = await add();
      const requestsBefore = runner.requests.length;
      await expect(service.change(resource.id, { kind: "smb", host: "attacker.example" }, actor)).rejects.toBeInstanceOf(
        SharePasswordRequiredError,
      );
      // Refused before the unit stopped: the share stays mounted as it was.
      expect(runner.calls).not.toContain(`stop ${resource.id}`);
      expect(runner.requests).toHaveLength(requestsBefore);
      expect(service.get(resource.id)).toEqual(resource);

      const changed = await service.change(resource.id, { kind: "smb", host: "10.0.0.5", password: "an0ther-one" }, actor);
      expect(changed).toEqual({ ...resource, host: "10.0.0.5" });
      expect(lastRequest()).toMatchObject({ host: "10.0.0.5", password: "an0ther-one" });
    });

    it("remounts with a new password and stores a new envelope", async () => {
      const resource = await add();
      const before = storedPassword(resource.id);
      const changed = await service.change(resource.id, { kind: "smb", password: "an0ther-one" }, actor);
      expect(changed).toEqual(resource);
      expect(lastRequest()).toMatchObject({ password: "an0ther-one" });
      const after = String(storedPassword(resource.id));
      expect(after).not.toBe(before);
      expect(testSecrets.decrypt("smb", passwordAad(resource.id), after)).toBe("an0ther-one");
      expect(audited("resource.changed")).toEqual([expect.objectContaining({ details: { fields: ["password"] } })]);
      expect(JSON.stringify(audited())).not.toContain("an0ther-one");
    });

    it("mounts the old settings again when the new ones fail", async () => {
      const resource = await add();
      runner.failNextStart = "no-share";
      expect(await shareRefusal(service.change(resource.id, { kind: "smb", share: "Typo" }, actor))).toBe("no-share");
      expect(runner.requests.slice(-2).map((received) => received.request)).toEqual([
        expect.objectContaining({ share: "Typo" }),
        expect.objectContaining({ share: "Photos", password: PASSWORD }),
      ]);
      expect(runner.active.has(resource.id)).toBe(true);
      expect(service.get(resource.id)).toEqual(resource);
      expect(audited("resource.changed")).toEqual([]);
    });
  });

  describe("removing a share", () => {
    it("unmounts it", async () => {
      const resource = await add();
      await service.remove(resource.id, actor);
      expect(runner.calls.at(-1)).toBe(`stop ${resource.id}`);
      expect(runner.active.size).toBe(0);
      expect(audited("resource.removed")).toHaveLength(1);
    });

    it("is forgotten even when the unit won't stop, and the log names the unit", async () => {
      const resource = await add();
      runner.failStopWith = "mount-failed";
      await service.remove(resource.id, actor);
      expect(service.list().resources).toEqual([]);
      expect(logs()).toContainEqual(expect.objectContaining({ level: 50, unit: `not-unreachable-mount@${resource.id}.service` }));
    });
  });

  describe("at startup", () => {
    it("uses a mount still there from an earlier run as it is", async () => {
      const resource = await add();
      writeMountInfo(mountInfo, [join(mountRoot, resource.id)]);
      runner.calls.length = 0;
      const restarted = restart();
      await restarted.checkAtStartup();
      expect(runner.calls).toEqual([`is-active ${resource.id}`]);
      expect(restarted.get(resource.id)).toMatchObject({ state: "available" });
    });

    it("stops and starts an active unit without a mount", async () => {
      const resource = await add();
      runner.calls.length = 0;
      await restart().checkAtStartup();
      expect(runner.calls).toEqual([`is-active ${resource.id}`, `stop ${resource.id}`, `start ${resource.id}`]);
      expect(lastRequest()).toMatchObject({ password: PASSWORD });
    });

    it("marks a share that fails unavailable, records why, and retries after 1, 2, 5, then every 10 minutes", async () => {
      const resource = await add();
      runner.active.clear();
      runner.failWith = "unreachable";
      const restarted = restart();
      await restarted.checkAtStartup();
      expect(restarted.get(resource.id)).toMatchObject({ state: "unavailable", unavailableReason: "unreachable" });
      expect(audited("resource.mount-failed")).toEqual([
        expect.objectContaining({
          actorKind: "system",
          targetKind: "resource",
          targetId: resource.id,
          outcome: "failed",
          details: { reason: "unreachable" },
        }),
      ]);

      const attempts: number[] = [];
      let minute = 0;
      const startsBefore = startsOf(resource.id);
      for (; minute < 40; minute += 1) {
        clock.advance(MINUTE_MS);
        const before = startsOf(resource.id);
        await restarted.retryDue();
        if (startsOf(resource.id) > before) attempts.push(minute + 1);
      }
      // After the startup failure: +1, then +2, +5, +10, +10, +10.
      expect(attempts).toEqual([1, 3, 8, 18, 28, 38]);
      expect(startsOf(resource.id) - startsBefore).toBe(6);
      expect(audited("resource.mount-failed")).toHaveLength(7);

      runner.failWith = undefined;
      clock.advance(10 * MINUTE_MS);
      await restarted.retryDue();
      expect(restarted.get(resource.id)).toMatchObject({ state: "available", unavailableReason: null });
      const afterSuccess = startsOf(resource.id);
      clock.advance(60 * MINUTE_MS);
      await restarted.retryDue();
      expect(startsOf(resource.id)).toBe(afterSuccess);
    });

    it("lets a removal wait for a retry under way, so the share isn't left mounted", async () => {
      const resource = await add();
      runner.active.clear();
      runner.failWith = "unreachable";
      const restarted = restart();
      await restarted.checkAtStartup();
      runner.failWith = undefined;

      const { promise: startHeld, resolve: releaseStart } = Promise.withResolvers<void>();
      const start = runner.start.bind(runner);
      runner.start = async (id) => {
        await startHeld;
        return start(id);
      };
      clock.advance(MINUTE_MS);
      const retrying = restarted.retryDue();
      const removing = restarted.remove(resource.id, actor);
      releaseStart();
      await Promise.all([retrying, removing]);

      expect(runner.calls.slice(-2)).toEqual([`start ${resource.id}`, `stop ${resource.id}`]);
      expect(runner.active.size).toBe(0);
      expect(restarted.list().resources).toEqual([]);
    });
  });

  it("has its password re-encrypted by rotate-key", async () => {
    const resource = await add();
    const newKey = Buffer.alloc(32, 9);
    const rotated = rotateMasterKey({ database, oldKey: Buffer.alloc(32, 7), newKey, columns: envelopeColumns });
    expect(rotated).toContainEqual({ table: "resources", column: "smb_password", reencrypted: 1 });
    expect(createSecrets(newKey).decrypt("smb", passwordAad(resource.id), String(storedPassword(resource.id)))).toBe(PASSWORD);
  });
});
