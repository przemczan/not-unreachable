import { isAbsolute, relative, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const NO_CACHE = "no-cache";
const INDEX = "index.html";

/** Vite's content-hashed build output: safe to cache forever. */
function isHashedAsset(webRoot: string, file: string): boolean {
  const path = relative(webRoot, file);
  return !isAbsolute(path) && path.startsWith(`assets${sep}`);
}

/**
 * Serves the built SPA from `webRoot`: hashed assets cached for a year, everything else
 * revalidated. No directory listings, no dotfiles; a miss goes to the not-found handler, which
 * falls back to `index.html` (see {@link sendSpaIndex}).
 */
export async function registerStaticWeb(app: FastifyInstance, webRoot: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    wildcard: true,
    // "/" serves index.html; any other directory is never listed (403 with a trailing slash, else the fallback).
    index: [INDEX],
    list: false,
    redirect: false,
    dotfiles: "ignore",
    serveDotFiles: false,
    cacheControl: false,
    etag: true,
    lastModified: true,
    preCompressed: false,
    setHeaders: (reply, file) => {
      reply.header("cache-control", isHashedAsset(webRoot, file) ? IMMUTABLE : NO_CACHE);
    },
  });
}

/** The SPA fallback: the client router handles any other path. */
export function sendSpaIndex(reply: FastifyReply): FastifyReply {
  return reply.code(200).sendFile(INDEX);
}
