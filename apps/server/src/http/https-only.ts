import { isIP } from "node:net";
import { problemTypes } from "@not-unreachable/contracts";
import type { FastifyInstance } from "fastify";
import type { Config } from "../modules/platform/index.ts";
import { HttpProblem } from "./problems.ts";

export function isLoopback(ip: string): boolean {
  const address = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

/**
 * Every request must have come over https, as the trusted proxy reports it (deployment.md). The one
 * exception is development: a `http://localhost` origin, with the caller on loopback.
 */
export function registerHttpsOnly(app: FastifyInstance, config: Pick<Config, "publicOrigin">): void {
  const localDevelopment = new URL(config.publicOrigin).protocol === "http:";
  app.addHook("onRequest", async (request) => {
    if (request.protocol === "https") return;
    if (localDevelopment && isLoopback(request.ip)) return;
    throw new HttpProblem(400, problemTypes.httpsRequired);
  });
}
