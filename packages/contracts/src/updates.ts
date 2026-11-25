import { z } from "zod";
import { reauthenticationSchema } from "./resources.ts";
import { defineRoute } from "./route.ts";

/**
 * Why an update didn't succeed (deployment.md, "The update contracts"): the update helper's reasons,
 * which it writes to the status file and, for the verify unit, as its exit code, and the server's own
 * (`download-failed`, `download-incomplete`). The admin interface has its words for each.
 */
export const updateReasons = [
  "internal",
  "request-invalid",
  "switch-off",
  "busy",
  "interrupted",
  "download-failed",
  "download-incomplete",
  "unsigned",
  "signature-invalid",
  "checksum-mismatch",
  "version-mismatch",
  "not-newer",
  "archive-unsafe",
  "archive-invalid",
  "needs-installer",
  "systemd-failed",
  "no-space",
  "installer-failed",
  "start-failed",
  "unhealthy",
] as const;
export type UpdateReason = (typeof updateReasons)[number];

/** The phases the status file holds; `downloading` is the server's own, kept in memory. */
export const updateStatusPhases = ["verifying", "verified", "installing", "restarting", "rolling-back", "finished"] as const;
export type UpdateStatusPhase = (typeof updateStatusPhases)[number];

export const updatePhases = ["downloading", ...updateStatusPhases] as const;
export type UpdatePhase = (typeof updatePhases)[number];

export const updateResults = ["succeeded", "refused", "rolled-back", "rollback-failed", "interrupted"] as const;
export type UpdateResult = (typeof updateResults)[number];

/** A release version: SemVer 2.0, as the releases are named (`isReleaseVersion` of the update helper). */
export const releaseVersionSchema = z
  .string()
  .max(64)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );

const signingKeyIdSchema = z.string().regex(/^[0-9a-f]{16}$/);

/**
 * `/var/lib/not-unreachable-update/status.json`, written by the update helper only. The server reads
 * it with this schema; a file that doesn't parse is shown as unknown, never trusted.
 */
export const updateStatusFileSchema = z
  .strictObject({
    schema: z.literal(1),
    requestId: z.uuid(),
    from: releaseVersionSchema,
    to: releaseVersionSchema,
    phase: z.enum(updateStatusPhases),
    result: z.enum(updateResults).nullable(),
    reason: z.enum(updateReasons).nullable(),
    signingKey: signingKeyIdSchema.nullable(),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (status) => (status.phase === "finished") === (status.result !== null) && (status.result !== null) === (status.finishedAt !== null),
    "a result and a finish time exactly when finished",
  )
  .refine(
    (status) => (status.reason === null) === (status.result === null || status.result === "succeeded"),
    "a reason exactly when it didn't succeed",
  );

export type UpdateStatusFile = z.infer<typeof updateStatusFileSchema>;

/** The command that turns installing from Settings on, shown while it is off. */
export const UPDATE_FROM_UI_ON_COMMAND = "sudo not-unreachable update-from-ui on";

/** Why the latest release can't be installed from Settings. */
export const notInstallableReasons = ["not-newer", "unsigned", "no-tarball"] as const;
export type NotInstallableReason = (typeof notInstallableReasons)[number];

export const latestReleaseSchema = z.strictObject({
  version: releaseVersionSchema,
  publishedAt: z.iso.datetime(),
  /** The Release's `html_url`, under https://github.com/przemczan/not-unreachable/releases/. */
  releaseNotesUrl: z.url(),
  installable: z.boolean(),
  notInstallableBecause: z.enum(notInstallableReasons).nullable(),
});

export type LatestRelease = z.infer<typeof latestReleaseSchema>;

export const updateSchema = z.strictObject({
  requestId: z.uuid(),
  from: releaseVersionSchema,
  to: releaseVersionSchema,
  phase: z.enum(updatePhases),
  result: z.enum(updateResults).nullable(),
  reason: z.enum(updateReasons).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export type Update = z.infer<typeof updateSchema>;

export const updatesOverviewSchema = z.strictObject({
  current: z.strictObject({ version: z.string() }),
  check: z.discriminatedUnion("enabled", [
    z.strictObject({ enabled: z.literal(false) }),
    z.strictObject({
      enabled: z.literal(true),
      /** When GitHub last answered; null before the first answer. */
      checkedAt: z.iso.datetime().nullable(),
      /** A later check that failed, if any. */
      failedAt: z.iso.datetime().nullable(),
      latest: latestReleaseSchema.nullable(),
    }),
  ]),
  install: z.strictObject({
    /** `UPDATE_FROM_UI`. */
    enabled: z.boolean(),
    switchCommand: z.literal(UPDATE_FROM_UI_ON_COMMAND),
    /** The one-line installer, to update over SSH instead. */
    installerCommand: z.string(),
  }),
  /** The update in progress, or the last one; null before the first. */
  update: updateSchema.nullable(),
});

export type UpdatesOverview = z.infer<typeof updatesOverviewSchema>;

export const installUpdateRequestSchema = z.strictObject({
  version: releaseVersionSchema,
  reauthentication: reauthenticationSchema,
});

export type InstallUpdateRequest = z.input<typeof installUpdateRequestSchema>;

export const updateRequestedSchema = z.strictObject({ requestId: z.uuid() });

export type UpdateRequested = z.infer<typeof updateRequestedSchema>;

export const getUpdatesRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/updates",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: updatesOverviewSchema },
});

/** Asks GitHub now. Answers only while `UPDATE_CHECK=true` (a 404 otherwise); 429 past the limits. */
export const checkForUpdatesRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/updates/check",
  access: "admin",
  recentSignIn: false,
  safe: false,
  responses: { 200: updatesOverviewSchema },
});

/**
 * Downloads the latest release and hands it to the update helper, which verifies, installs and
 * restarts; the app is then away for a while, and `GET /api/v1/admin/updates` tells how it ended.
 * Answers only while `UPDATE_FROM_UI=true` (a 404 otherwise). The proof of both factors is in the
 * body, every time: 401 `sign-in-failed` or `second-factor-failed`; 409 `update-not-available` when
 * the version isn't the latest installable release, `update-in-progress` while one runs; 429 past
 * the limits.
 */
export const installUpdateRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/updates/install",
  access: "admin",
  recentSignIn: false,
  safe: false,
  body: installUpdateRequestSchema,
  responses: { 202: updateRequestedSchema },
});
