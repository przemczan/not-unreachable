import { z } from "zod";
import { defineRoute } from "./route.ts";

export const healthSchema = z.strictObject({
  status: z.literal("ok"),
});

export type Health = z.infer<typeof healthSchema>;

export const healthRoute = defineRoute({
  method: "GET",
  path: "/api/v1/health",
  access: "public",
  recentSignIn: false,
  safe: true,
  responses: { 200: healthSchema },
});
