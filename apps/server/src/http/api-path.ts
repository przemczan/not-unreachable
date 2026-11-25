import { decodeAsciiEscapes } from "../modules/platform/index.ts";

/**
 * Whether a request URL (path and query) is under `/api`, where no SPA fallback and no static files
 * apply. It decodes the path as the router does, so `/%61pi/…` counts as `/api/…`.
 */
export function isApiPath(url: string): boolean {
  const end = url.search(/[?#]/);
  const path = decodeAsciiEscapes(end === -1 ? url : url.slice(0, end));
  return path === "/api" || path.startsWith("/api/");
}
