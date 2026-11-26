import { z } from "zod";
import { defineRoute } from "./route.ts";

const count = z.number().int().nonnegative();

/** How many days back the Dashboard's Recent uploads reach, counted back from now. */
export const RECENT_UPLOADS_DAYS = 7;
/** The most users the Dashboard's Recent uploads lists. */
export const RECENT_UPLOADERS_LIMIT = 10;

/** A user who uploaded files themselves lately: how many uploads, and when the last one was. */
export const recentUploaderSchema = z.strictObject({
  userId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  uploads: count,
  lastUploadAt: z.iso.datetime(),
});

export type RecentUploader = z.infer<typeof recentUploaderSchema>;

/**
 * The admin Dashboard's counts, each a database aggregate of its owning module. No storage total:
 * that would mean scanning folders.
 */
export const dashboardSchema = z.strictObject({
  /** Accounts with the `user` role. */
  users: z.strictObject({ active: count, disabled: count }),
  pendingInvitations: count,
  resources: z.strictObject({ available: count, unavailable: count }),
  /** `locked` counts active links locked after wrong passwords; `downloads` totals every link's downloads. */
  shareLinks: z.strictObject({
    active: count,
    expired: count,
    revoked: count,
    locked: count,
    downloads: count,
  }),
  /**
   * Users who uploaded files themselves in the last {@link RECENT_UPLOADS_DAYS} days, last upload
   * newest first, at most {@link RECENT_UPLOADERS_LIMIT}. Only users' own successful uploads count:
   * the admin's uploads into a home don't, and the admin and removed accounts never appear.
   */
  recentUploaders: z.array(recentUploaderSchema).max(RECENT_UPLOADERS_LIMIT),
});

export type Dashboard = z.infer<typeof dashboardSchema>;

export const getDashboardRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/dashboard",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: dashboardSchema },
});
