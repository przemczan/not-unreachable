import { z } from "zod";
import { defineRoute } from "./route.ts";

const count = z.number().int().nonnegative();

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
