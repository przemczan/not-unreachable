import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_SMB_PROTOCOL, smbEncrypts, type ShareFailure, type SmbProtocol } from "@not-unreachable/contracts";
import type { AuditService } from "../audit/index.ts";
import type { EnvelopeAad, Logger, Secrets } from "../platform/index.ts";
import { fixRoot, list, resolveInResource, type FixedRoot, type RealPath } from "../storage/index.ts";
import { ResourceNotFoundError, SharePasswordRequiredError } from "./errors.ts";
import type { Activation, KindColumns, KindRefusal, ResourceChangedField, ResourceKindDefinition } from "./kinds.ts";
import { deleteMountRequest, isCifsMount, writeMountRequest } from "./mount-requests.ts";
import type { MountRetries } from "./mount-retries.ts";
import { mountUnit, type MountOutcome, type MountRunner } from "./mount-runner.ts";
import type { ResourceRow } from "./schema.ts";

export interface SmbShareDependencies {
  /** The master key's secrets, which the stored passwords are encrypted under; the CLI has none. */
  readonly secrets: Secrets | undefined;
  readonly audit: AuditService;
  readonly logger: Logger;
  /** Each share is mounted at `<mountRoot>/<id>` by the helper. */
  readonly mountRoot: string;
  /** Where the app writes the helper's request files. */
  readonly requestsDir: string;
  readonly runner: MountRunner;
  readonly retries: MountRetries;
  readonly findResource: (id: string) => ResourceRow | undefined;
  /** `/proc/self/mountinfo` unless given; tests pass a file of their own. */
  readonly mountInfoPath?: string;
  /** `storage.fixRoot` unless given. */
  readonly fixRoot?: (absolute: string) => Promise<FixedRoot>;
}

/** A share's connection settings, `encrypt` as it is used (never true on SMB 2.1). */
interface SmbSettings {
  readonly host: string;
  readonly share: string;
  readonly subfolder: string;
  readonly username: string;
  readonly domain: string;
  readonly protocol: SmbProtocol;
  readonly encrypt: boolean;
}

/** The connection fields `resource.changed` may name, in the audit's order. */
const CHANGE_FIELDS = [
  "host",
  "share",
  "subfolder",
  "username",
  "password",
  "domain",
  "protocol",
  "encrypt",
] as const satisfies readonly ResourceChangedField[];

type Mounted = { readonly ok: true; readonly realPath: RealPath } | { readonly ok: false; readonly reason: ShareFailure };

function normalise(settings: SmbSettings): SmbSettings {
  return { ...settings, encrypt: smbEncrypts(settings.protocol, settings.encrypt) };
}

function settingsOf(input: SmbSettings): SmbSettings {
  const { host, share, subfolder, username, domain, protocol, encrypt } = input;
  return normalise({ host, share, subfolder, username, domain, protocol, encrypt });
}

function storedSettings(row: ResourceRow): SmbSettings {
  return normalise({
    host: row.smbHost ?? "",
    share: row.smbShare ?? "",
    subfolder: row.smbSubfolder ?? "",
    username: row.smbUsername ?? "",
    domain: row.smbDomain ?? "",
    protocol: row.smbProtocol ?? DEFAULT_SMB_PROTOCOL,
    encrypt: row.smbEncrypt ?? true,
  });
}

function settingsColumns(settings: SmbSettings): KindColumns {
  return {
    smbHost: settings.host,
    smbShare: settings.share,
    smbSubfolder: settings.subfolder,
    smbUsername: settings.username,
    smbDomain: settings.domain,
    smbProtocol: settings.protocol,
    smbEncrypt: settings.encrypt,
  };
}

function passwordAad(id: string): EnvelopeAad {
  return { table: "resources", column: "smb_password", rowId: id };
}

function refusal(reason: ShareFailure): KindRefusal {
  return { ok: false, reason, command: null, allowFromUi: false };
}

/** The `smb` kind: a share on an SMB server, mounted by the root helper (smb.md). */
export function createSmbShareKind(dependencies: SmbShareDependencies): ResourceKindDefinition<"smb"> {
  const { audit, logger, runner, retries } = dependencies;
  const fix = dependencies.fixRoot ?? fixRoot;
  const mountPointOf = (id: string): string => join(dependencies.mountRoot, id);

  const requireSecrets = (): Secrets => {
    if (dependencies.secrets === undefined) throw new Error("SMB shares need the master key");
    return dependencies.secrets;
  };
  const encryptPassword = (id: string, password: string): string => requireSecrets().encrypt("smb", passwordAad(id), password);
  const storedPassword = (row: ResourceRow): string => {
    if (row.smbPassword === null) throw new Error("The SMB share has no stored password");
    return requireSecrets().decrypt("smb", passwordAad(row.id), row.smbPassword);
  };

  /** Stops the unit; a failure is logged, as there is nothing better to do with it. */
  const stop = async (id: string): Promise<boolean> => {
    const stopped = await runner.stop(id);
    if (!stopped.ok)
      logger.error({ unit: mountUnit(id), reason: stopped.reason }, "The share couldn't be unmounted; stop the unit by hand");
    return stopped.ok;
  };

  /** Hands the settings to the helper, mounts the share at `<mountRoot>/<id>` and fixes it as a root. */
  const mount = async (id: string, settings: SmbSettings, password: string): Promise<Mounted> => {
    const { host, share, subfolder, username, domain, protocol, encrypt } = settings;
    try {
      await writeMountRequest(dependencies.requestsDir, id, {
        host,
        share,
        subfolder,
        username,
        password,
        domain,
        vers: protocol,
        seal: encrypt,
      });
    } catch (error) {
      // No request folder to write to (the helper isn't installed, or /run is not the service's).
      logger.error({ err: error, unit: mountUnit(id) }, "The mount request couldn't be written");
      await deleteMountRequest(dependencies.requestsDir, id).catch(() => undefined);
      return { ok: false, reason: "helper-unavailable" };
    }
    let started: MountOutcome;
    try {
      started = await runner.start(id);
    } finally {
      // The helper deletes it itself; this covers a timeout or a helper that never ran.
      await deleteMountRequest(dependencies.requestsDir, id);
    }
    if (!started.ok) return started;
    const fixed = await fix(mountPointOf(id));
    if (fixed.ok) return fixed;
    logger.warn({ unit: mountUnit(id), reason: fixed.reason }, "The share mounted but the service can't use it");
    await stop(id);
    return { ok: false, reason: "mount-failed" };
  };

  /** Startup and Retry: a mount still there from an earlier run, else the stored settings mounted again. */
  const remount = async (row: ResourceRow): Promise<Mounted> => {
    if (await runner.isActive(row.id)) {
      const mountPoint = mountPointOf(row.id);
      if (await isCifsMount(mountPoint, dependencies.mountInfoPath)) {
        const fixed = await fix(mountPoint);
        if (fixed.ok) return fixed;
      }
      // Starting an active unit does nothing, so it has to stop first.
      if (!(await stop(row.id))) return { ok: false, reason: "mount-failed" };
    }
    let password: string;
    try {
      password = storedPassword(row);
    } catch (error) {
      logger.error({ err: error, resourceId: row.id }, "The share's stored password couldn't be decrypted");
      return { ok: false, reason: "mount-failed" };
    }
    return mount(row.id, storedSettings(row), password);
  };

  /**
   * The stored password, for the server it was saved for only: sent to another one, whoever can
   * change the host would get a sign-in attempt with it to crack or relay.
   */
  const storedPasswordFor = (row: ResourceRow, host: string): string => {
    if (host !== storedSettings(row).host) throw new SharePasswordRequiredError();
    return storedPassword(row);
  };

  /** Test connection on a saved share with the password left out: the stored one. */
  const testPassword = (resourceId: string | undefined, host: string): string => {
    const row = resourceId === undefined ? undefined : dependencies.findResource(resourceId);
    if (row?.kind !== "smb") throw new ResourceNotFoundError();
    return storedPasswordFor(row, host);
  };

  const recordFailure = (id: string, reason: ShareFailure): void => {
    retries.recordFailure(id);
    audit.record({
      action: "resource.mount-failed",
      actor: { kind: "system" },
      outcome: "failed",
      target: { kind: "resource", id },
      details: { reason },
    });
  };

  return {
    kind: "smb",

    async prepare(input, id) {
      // Before mounting: a share mounted for a password that can't be stored would stay mounted.
      requireSecrets();
      const mounted = await mount(id, settingsOf(input), input.password);
      if (!mounted.ok) return refusal(mounted.reason);
      return {
        ok: true,
        realPath: mounted.realPath,
        columns: { ...settingsColumns(settingsOf(input)), smbPassword: encryptPassword(id, input.password) },
      };
    },

    async prepareChange(row, change) {
      requireSecrets();
      const current = storedSettings(row);
      const next = normalise({
        host: change.host ?? current.host,
        share: change.share ?? current.share,
        subfolder: change.subfolder ?? current.subfolder,
        username: change.username ?? current.username,
        domain: change.domain ?? current.domain,
        protocol: change.protocol ?? current.protocol,
        encrypt: change.encrypt ?? current.encrypt,
      });
      // A password given counts as changed: the stored one is never compared in clear text.
      const fields = CHANGE_FIELDS.filter((field) =>
        field === "password" ? change.password !== undefined : next[field] !== current[field],
      );
      if (fields.length === 0) return { ok: true, fields: [] };
      // Before the unit stops: a refused change leaves the share as it was.
      const password = change.password ?? storedPasswordFor(row, next.host);

      if (!(await stop(row.id))) return refusal("mount-failed");
      const mounted = await mount(row.id, next, password);
      if (!mounted.ok) {
        // Best effort: the share stays as it was, and the admin sees why the new settings failed.
        if (row.state === "available") {
          const restored = await mount(row.id, current, storedPassword(row));
          if (!restored.ok) logger.warn({ resourceId: row.id, reason: restored.reason }, "The share's old settings didn't mount again");
        }
        return refusal(mounted.reason);
      }
      retries.recordSuccess(row.id);
      return {
        ok: true,
        fields,
        realPath: mounted.realPath,
        columns: {
          ...settingsColumns(next),
          ...(change.password === undefined ? {} : { smbPassword: encryptPassword(row.id, change.password) }),
        },
      };
    },

    async activate(row): Promise<Activation> {
      const mounted = await remount(row);
      if (!mounted.ok) {
        recordFailure(row.id, mounted.reason);
        return mounted;
      }
      retries.recordSuccess(row.id);
      if (mounted.realPath === row.rootRealpath) return { ok: true, realPath: mounted.realPath };
      // The mount root moved under the service: nothing to retry until the admin looks at it.
      await stop(row.id);
      return { ok: false, reason: "changed" };
    },

    async deactivate(id) {
      retries.forget(id);
      // Logged, not thrown: the resource is forgotten anyway, and the log names the unit to stop.
      await stop(id);
    },

    async test(input) {
      const password = input.password ?? testPassword(input.resourceId, input.host);
      const id = randomUUID();
      try {
        const mounted = await mount(id, settingsOf(input), password);
        if (!mounted.ok) return { outcome: "failed", reason: mounted.reason };
        const entries = await list(await resolveInResource(mounted.realPath, ""));
        return { outcome: "connected", folderCount: entries.filter((entry) => entry.kind === "folder").length };
      } finally {
        await stop(id);
      }
    },

    onStartup: async () => undefined,
    dueForRetry: () => retries.due(),

    present(row) {
      const { host, share, subfolder, username, domain, protocol, encrypt } = storedSettings(row);
      return { kind: "smb", host, share, subfolder, username, domain, protocol, encrypt, smbPasswordSet: row.smbPassword !== null };
    },
  };
}
