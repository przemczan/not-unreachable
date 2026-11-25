import { z } from "zod";
import { enteredPasswordSchema, totpCodeSchema } from "./accounts.ts";
import { defineRoute } from "./route.ts";
import { passkeyAuthenticationResponseSchema } from "./webauthn.ts";

/**
 * The kinds of resource (domain.md, Glossary). Each kind is one branch of the discriminated unions
 * below, so a new kind adds its branch without changing the others.
 */
export const resourceKinds = ["local", "smb"] as const;
export type ResourceKind = (typeof resourceKinds)[number];

export const resourceStates = ["available", "unavailable"] as const;
export type ResourceState = (typeof resourceStates)[number];

/**
 * Why a local folder is refused when it is added, changed or checked. The UI maps each to its
 * wording; `not-writable` comes with the `allow-folder` command that fixes it.
 */
export const folderRefusals = [
  "not-absolute",
  "missing",
  "not-a-folder",
  "not-writable",
  "inside-data-directory",
  "inside-release-directory",
  "inside-mount-root",
] as const;
export type FolderRefusal = (typeof folderRefusals)[number];

/**
 * Why a folder can't be allowed from the admin interface (deployment.md, "Allowing folders from the
 * admin interface"): the path rules of `allow-folder`, then the ones only the admin interface has.
 * `sudo not-unreachable allow-folder` on the server may still allow a folder refused here.
 */
export const allowFolderRefusals = [
  "not-absolute",
  "missing",
  "not-a-folder",
  "inside-data-directory",
  "inside-release-directory",
  "inside-mount-root",
  /** Not below one of `ALLOWED_FOLDER_PREFIXES`, once its symlinks are resolved. */
  "outside-allowed-folders",
  /** Inside or holding a system folder such as /etc, /usr or /var. */
  "system-folder",
  /** A backslash, a double quote or a control character, which the systemd drop-in can't list. */
  "unsupported-path",
  /** Inside or holding a folder the service may write to already; only the folder helper checks it. */
  "overlaps-allowed-folder",
] as const;
export type AllowFolderRefusal = (typeof allowFolderRefusals)[number];

/**
 * Why an SMB share couldn't be mounted, from the mount helper's exit code (smb.md, "What happens
 * underneath"); `helper-unavailable` when systemd didn't run the helper at all.
 */
export const shareFailures = ["auth", "unreachable", "no-share", "not-supported", "mount-failed", "helper-unavailable"] as const;
export type ShareFailure = (typeof shareFailures)[number];

export function isShareFailure(reason: string): reason is ShareFailure {
  return shareFailures.some((failure) => failure === reason);
}

/** Why a saved resource is unavailable, found at startup or on Retry. */
export const unavailableReasons = ["missing", "not-a-folder", "changed", "not-writable", ...shareFailures] as const;
export type UnavailableReason = (typeof unavailableReasons)[number];

export const RESOURCE_NAME_MAX_CHARACTERS = 64;
/** In characters here; the server also limits it to 4096 bytes (threat model, T5). */
export const LOCAL_PATH_MAX_BYTES = 4096;

export const resourceNameSchema = z.string().trim().min(1).max(RESOURCE_NAME_MAX_CHARACTERS);

/** An absolute path on the server, as the admin typed it; the server fixes its real path. */
export const localPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(LOCAL_PATH_MAX_BYTES)
  .refine((path) => !path.includes("\0"), "The path can't hold a NUL character");

/**
 * A folder inside a resource, relative to it, with `/` between its segments; empty for the
 * resource's own top folder. The server checks it as it checks every path (threat model, T5).
 */
export const resourceSubpathSchema = z.string().trim().max(LOCAL_PATH_MAX_BYTES);

/** The SMB dialects the admin can pick; 3.1.1 unless the server is older. */
export const smbProtocols = ["3.1.1", "3.0", "2.1"] as const;
export type SmbProtocol = (typeof smbProtocols)[number];
export const DEFAULT_SMB_PROTOCOL: SmbProtocol = "3.1.1";

/** SMB 2.1 has no encryption, so a share on it is never encrypted. */
export function smbEncrypts(protocol: SmbProtocol, encrypt: boolean): boolean {
  return encrypt && protocol !== "2.1";
}

// The SMB fields' rules, which keep any field from adding a mount option (no `,` or `=`). The
// mount helper checks them again itself and never trusts the app (smb.md, "Validation").
const SMB_HOST_NAME = /^[A-Za-z0-9.-]{1,253}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const SMB_SHARE_SEGMENT = /^[^/\\:*?"<>|,=\p{Cc}]{1,80}$/u;
const SMB_FOLDER_SEGMENT = /^[^/\\:*?"<>|,=\p{Cc}]{1,255}$/u;
const SMB_ACCOUNT_NAME = /^[^,=\p{Cc}]{1,104}$/u;
export const SMB_SUBFOLDER_MAX_CHARACTERS = 1024;
export const SMB_PASSWORD_MAX_CHARACTERS = 256;

const IPV6 = z.ipv6();

function isIpv6(text: string): boolean {
  return IPV6.safeParse(text).success;
}

const notDots = (segment: string): boolean => segment !== "." && segment !== "..";

/** A host name, an IPv4 address or an IPv6 address (without brackets). */
export const smbHostSchema = z
  .string()
  .trim()
  .refine((host) => SMB_HOST_NAME.test(host) || IPV4.test(host) || isIpv6(host), "Enter a host name or an IP address");
export const smbShareSchema = z
  .string()
  .trim()
  .refine((share) => SMB_SHARE_SEGMENT.test(share) && notDots(share), "Enter the share's name, without slashes");
/** A folder inside the share, `/` between its segments; empty for the share's top folder. */
export const smbSubfolderSchema = z
  .string()
  .trim()
  .max(SMB_SUBFOLDER_MAX_CHARACTERS)
  .transform((folder) => folder.replace(/^\/+|\/+$/g, ""))
  .refine(
    (folder) => folder === "" || folder.split("/").every((segment) => SMB_FOLDER_SEGMENT.test(segment) && notDots(segment)),
    "Enter a folder inside the share, such as Photos/2026",
  );
export const smbUsernameSchema = z.string().trim().regex(SMB_ACCOUNT_NAME, "Enter the user name, without commas or =");
export const smbDomainSchema = z
  .string()
  .trim()
  .refine((domain) => domain === "" || SMB_ACCOUNT_NAME.test(domain), "Enter the domain, without commas or =");
export const smbPasswordSchema = z
  .string()
  .min(1)
  .max(SMB_PASSWORD_MAX_CHARACTERS)
  .refine((password) => !/[\0\r\n]/.test(password), "The password can't hold a line break");

const resourceFields = {
  id: z.uuid(),
  name: z.string(),
  state: z.enum(resourceStates),
  /** Set exactly when the state is `unavailable`. */
  unavailableReason: z.enum(unavailableReasons).nullable(),
  /** Whether this resource holds the home root. */
  isHomeRoot: z.boolean(),
  createdAt: z.iso.datetime(),
};

export const localResourceSchema = z.strictObject({
  ...resourceFields,
  kind: z.literal("local"),
  /** The path as the admin typed it. */
  localPath: z.string(),
});

export const smbResourceSchema = z.strictObject({
  ...resourceFields,
  kind: z.literal("smb"),
  host: z.string(),
  share: z.string(),
  /** Empty for the share's top folder. */
  subfolder: z.string(),
  username: z.string(),
  /** Empty when the server needs none. */
  domain: z.string(),
  protocol: z.enum(smbProtocols),
  /** Whether traffic is encrypted (`seal`); never true on SMB 2.1. */
  encrypt: z.boolean(),
  /** The password is write-only: the API only says that one is stored (threat model, T6). */
  smbPasswordSet: z.boolean(),
});

/** A resource as the admin interface shows it; never a secret (an SMB password is write-only). */
export const resourceSchema = z.discriminatedUnion("kind", [localResourceSchema, smbResourceSchema]);
export type Resource = z.infer<typeof resourceSchema>;

/** The resource (and the folder inside it) that holds every user's home. */
export const homeRootSchema = z.strictObject({
  resourceId: z.uuid(),
  /** Empty when the homes sit in the resource's top folder. */
  subpath: z.string(),
});
export type HomeRoot = z.infer<typeof homeRootSchema>;

export const resourceListSchema = z.strictObject({
  resources: z.array(resourceSchema),
  /** Null until the admin picks one; until then, users can't be invited. */
  homeRoot: homeRootSchema.nullable(),
});
export type ResourceList = z.infer<typeof resourceListSchema>;

export const newLocalResourceSchema = z.strictObject({
  kind: z.literal("local"),
  name: resourceNameSchema,
  localPath: localPathSchema,
});

/** An SMB share's connection settings, as Add resource and Test connection send them. */
const smbConnectionFields = {
  host: smbHostSchema,
  share: smbShareSchema,
  subfolder: smbSubfolderSchema.default(""),
  username: smbUsernameSchema,
  domain: smbDomainSchema.default(""),
  protocol: z.enum(smbProtocols).default(DEFAULT_SMB_PROTOCOL),
  /** Ignored on SMB 2.1, which can't encrypt. */
  encrypt: z.boolean().default(true),
};

export const newSmbResourceSchema = z.strictObject({
  kind: z.literal("smb"),
  name: resourceNameSchema,
  ...smbConnectionFields,
  password: smbPasswordSchema,
});

export const newResourceSchema = z.discriminatedUnion("kind", [newLocalResourceSchema, newSmbResourceSchema]);
export type NewResource = z.infer<typeof newResourceSchema>;

/** The fields to change; `kind` names the resource's kind, which never changes. */
export const localResourceChangeSchema = z.strictObject({
  kind: z.literal("local"),
  name: resourceNameSchema.optional(),
  localPath: localPathSchema.optional(),
});

/** A connection field changed remounts the share; a password left out keeps the stored one. */
export const smbResourceChangeSchema = z.strictObject({
  kind: z.literal("smb"),
  name: resourceNameSchema.optional(),
  host: smbHostSchema.optional(),
  share: smbShareSchema.optional(),
  subfolder: smbSubfolderSchema.optional(),
  username: smbUsernameSchema.optional(),
  domain: smbDomainSchema.optional(),
  protocol: z.enum(smbProtocols).optional(),
  encrypt: z.boolean().optional(),
  password: smbPasswordSchema.optional(),
});

export const resourceChangeSchema = z.discriminatedUnion("kind", [localResourceChangeSchema, smbResourceChangeSchema]);
export type ResourceChange = z.infer<typeof resourceChangeSchema>;

export const localFolderCheckRequestSchema = z.strictObject({
  kind: z.literal("local"),
  localPath: localPathSchema,
});

/**
 * "Test connection": mounts the share under a temporary id, lists its top folder and unmounts it.
 * Editing a saved share, the password may be left out with `resourceId` naming the share whose
 * stored password to use.
 */
export const smbConnectionCheckRequestSchema = z
  .strictObject({
    kind: z.literal("smb"),
    ...smbConnectionFields,
    password: smbPasswordSchema.optional(),
    resourceId: z.uuid().optional(),
  })
  .refine((request) => request.password !== undefined || request.resourceId !== undefined, {
    message: "Enter the password",
    path: ["password"],
  });

export const resourceCheckRequestSchema = z.discriminatedUnion("kind", [localFolderCheckRequestSchema, smbConnectionCheckRequestSchema]);
export type ResourceCheckRequest = z.infer<typeof resourceCheckRequestSchema>;

/**
 * What "Check folder" or "Test connection" found; a folder refusal the admin can fix on the host
 * carries the command to run.
 */
export const resourceCheckSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("ok") }),
  z.strictObject({
    outcome: z.literal("refused"),
    reason: z.enum(folderRefusals),
    /** The exact `sudo not-unreachable allow-folder <path>` line, for `not-writable` only. */
    command: z.string().nullable(),
    /**
     * For `not-writable` only: the admin can allow the folder from here instead, as
     * `ALLOW_FOLDERS_FROM_UI` is on and the folder passes every rule of `allowFolderRefusals`.
     */
    allowFromUi: z.boolean(),
  }),
  /** The share mounted: how many folders its top folder holds. */
  z.strictObject({ outcome: z.literal("connected"), folderCount: z.int().min(0) }),
  z.strictObject({ outcome: z.literal("failed"), reason: z.enum(shareFailures) }),
]);
export type ResourceCheck = z.infer<typeof resourceCheckSchema>;

export const homeRootRequestSchema = z.strictObject({
  resourceId: z.uuid(),
  subpath: resourceSubpathSchema.default(""),
});
export type HomeRootRequest = z.input<typeof homeRootRequestSchema>;

const resourceIdParamsSchema = z.strictObject({ id: z.uuid() });

export const listResourcesRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/resources",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: resourceListSchema },
});

export const addResourceRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/resources",
  access: "admin",
  recentSignIn: false,
  safe: false,
  body: newResourceSchema,
  responses: { 201: resourceSchema },
});

export const getResourceRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/resources/:id",
  access: "admin",
  recentSignIn: false,
  safe: true,
  params: resourceIdParamsSchema,
  responses: { 200: resourceSchema },
});

export const changeResourceRoute = defineRoute({
  method: "PATCH",
  path: "/api/v1/admin/resources/:id",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: resourceIdParamsSchema,
  body: resourceChangeSchema,
  responses: { 200: resourceSchema },
});

/**
 * Forgets the resource (an SMB share is unmounted); nothing on disk or on the share is ever deleted.
 * Refused for the home root's resource.
 */
export const removeResourceRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/admin/resources/:id",
  access: "admin",
  recentSignIn: true,
  safe: false,
  params: resourceIdParamsSchema,
  responses: { 204: z.undefined() },
});

/** Checks an unavailable resource again, as startup does. */
export const retryResourceRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/resources/:id/retry",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: resourceIdParamsSchema,
  responses: { 200: resourceSchema },
});

/** Checks a resource's settings before it is saved; it changes nothing. */
export const checkResourceRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/resources/checks",
  access: "admin",
  recentSignIn: false,
  safe: false,
  body: resourceCheckRequestSchema,
  responses: { 200: resourceCheckSchema },
});

/**
 * A fresh proof of both factors for one sensitive action, checked by the action itself rather than
 * through the recent sign-in: the password, and a code from an authenticator app or an assertion of
 * one of the account's passkeys over the challenge from `POST /api/v1/session/confirm/passkey-options`.
 */
export const reauthenticationSchema = z.strictObject({
  password: enteredPasswordSchema,
  secondFactor: z.union([z.strictObject({ code: totpCodeSchema }), z.strictObject({ passkey: passkeyAuthenticationResponseSchema })]),
});
export type Reauthentication = z.input<typeof reauthenticationSchema>;

export const allowFolderRequestSchema = z.strictObject({
  localPath: localPathSchema,
  reauthentication: reauthenticationSchema,
});
export type AllowFolderRequest = z.input<typeof allowFolderRequestSchema>;

/**
 * Lets the service write to a local folder, as `sudo not-unreachable allow-folder` does, then
 * restarts the service: the 202 comes just before it stops, and the app answers again once it
 * is back. Answers only while `ALLOW_FOLDERS_FROM_UI=true` (a 404 otherwise); refused with
 * 422 `folder-not-allowable` (reason: an `allowFolderRefusals` entry), 401 `sign-in-failed` or
 * `second-factor-failed` for a wrong proof, and 429 past the limits.
 */
export const allowFolderRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/resources/allowed-folders",
  access: "admin",
  recentSignIn: false,
  safe: false,
  body: allowFolderRequestSchema,
  responses: { 202: z.undefined() },
});

/** Existing homes stay where they are; only homes created later use the new home root. */
export const setHomeRootRoute = defineRoute({
  method: "PUT",
  path: "/api/v1/admin/home-root",
  access: "admin",
  recentSignIn: true,
  safe: false,
  body: homeRootRequestSchema,
  responses: { 200: homeRootSchema },
});
