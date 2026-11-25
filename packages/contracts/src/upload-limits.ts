import { z } from "zod";
import { defineRoute } from "./route.ts";

/** The upload limits (threat model, T7): the Limits tab of the Admin settings page. */
export const uploadLimitsSchema = z.strictObject({
  /** The largest file one upload may hold, in bytes. */
  maxFileBytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  /**
   * The free space an upload must leave on the staging disk and on the target: refused when it would
   * leave less than `percent` of the disk or less than `bytes`. It applies to the admin too.
   */
  diskReserve: z.strictObject({
    percent: z.int().min(0).max(50),
    bytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  /** Unfinished uploads one account may have at once. */
  inProgressPerAccount: z.int().min(1).max(100),
  /** Unfinished uploads the whole instance may have at once. */
  inProgressPerInstance: z.int().min(1).max(10_000),
  /** New uploads one account may start in an hour. */
  createdPerAccountPerHour: z.int().min(1).max(10_000),
});

export type UploadLimits = z.infer<typeof uploadLimitsSchema>;

export const getUploadLimitsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/settings/limits",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: uploadLimitsSchema },
});

export const updateUploadLimitsRoute = defineRoute({
  method: "PUT",
  path: "/api/v1/admin/settings/limits",
  access: "admin",
  recentSignIn: false,
  safe: false,
  body: uploadLimitsSchema,
  responses: { 200: uploadLimitsSchema },
});
